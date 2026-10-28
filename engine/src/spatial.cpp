#include "spatial.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

#include "parallel.hpp"

namespace ffe {
namespace {

// one 1D pass along `count` lines of `len` samples; sample i of line l is at base(l) + i*stride
template <class Base>
void blur_lines(float* data, std::size_t count, std::size_t len, std::size_t stride, Base base, double sigma,
                unsigned threads) {
  run_parallel(count, threads, [&](std::size_t l0, std::size_t l1) {
    std::vector<float> line(len), tmp(len);
    auto load = [&](std::size_t l) { float* p = data + base(l); for (std::size_t i = 0; i < len; ++i) line[i] = p[i * stride]; };
    auto store = [&](std::size_t l) { float* p = data + base(l); for (std::size_t i = 0; i < len; ++i) p[i * stride] = line[i]; };
    const long n = static_cast<long>(len);
    auto at = [&](const std::vector<float>& v, long i) { return v[static_cast<std::size_t>(std::clamp(i, 0L, n - 1))]; };
    if (sigma < 3.0) {
      const int r = std::max(1, static_cast<int>(std::ceil(3.0 * sigma)));
      std::vector<float> k(2 * r + 1);
      double sum = 0;
      for (int i = -r; i <= r; ++i) sum += k[i + r] = static_cast<float>(std::exp(-0.5 * i * i / (sigma * sigma)));
      for (auto& v : k) v = static_cast<float>(v / sum);
      for (std::size_t l = l0; l < l1; ++l) {
        load(l);
        for (long i = 0; i < n; ++i) {
          float s = 0;
          for (int j = -r; j <= r; ++j) s += k[j + r] * at(line, i + j);
          tmp[static_cast<std::size_t>(i)] = s;
        }
        line.swap(tmp);
        store(l);
      }
      return;
    }
    // three boxes approximating the Gaussian
    const double ideal = std::sqrt(12.0 * sigma * sigma / 3.0 + 1.0);
    int wl = static_cast<int>(std::floor(ideal));
    if (wl % 2 == 0) --wl;
    const int m = static_cast<int>(std::lround((12.0 * sigma * sigma - 3.0 * wl * wl - 12.0 * wl - 9.0) / (-4.0 * wl - 4.0)));
    for (std::size_t l = l0; l < l1; ++l) {
      load(l);
      for (int pass = 0; pass < 3; ++pass) {
        const long r = ((pass < m ? wl : wl + 2) - 1) / 2;
        const float inv = 1.0f / static_cast<float>(2 * r + 1);
        double acc = 0;
        for (long j = -r - 1; j < r; ++j) acc += at(line, j);
        for (long i = 0; i < n; ++i) {
          acc += at(line, i + r) - at(line, i - r - 1);
          tmp[static_cast<std::size_t>(i)] = static_cast<float>(acc) * inv;
        }
        line.swap(tmp);
      }
      store(l);
    }
  }, 16);
}

}  // namespace

void gaussian_blur(float* plane, int w, int h, double sigma_px, unsigned threads) {
  if (!(sigma_px > 0.05)) return;
  const std::size_t W = static_cast<std::size_t>(w), H = static_cast<std::size_t>(h);
  blur_lines(plane, H, W, 1, [W](std::size_t l) { return l * W; }, sigma_px, threads);
  blur_lines(plane, W, H, W, [](std::size_t l) { return l; }, sigma_px, threads);
}

bool spatial_active(const SpatialParams& p) { return p.dir_diffusion_um > 0; }

void render_spatial(const FilmPipeline& pipe, const float* in, float* out, int w, int h, const SpatialParams& p,
                    unsigned threads) {
  const std::size_t n = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  const double pitch_um = p.film_format_mm * 1000.0 / std::max(w, h);
  const int L = pipe.wavelengths();
  // planar buffers: log H, undeveloped dye, local interlayer inhibition
  std::vector<float> lh(3 * n), a0(3 * n), inhib(3 * n);
  run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
    for (std::size_t i = s; i < e; ++i) {
      float ex[3], l[3], a[3], q[3];
      pipe.layer_exposure(in + 3 * i, ex);
      pipe.log_exposure(ex, l);
      pipe.undeveloped(l, a, q);
      for (int k = 0; k < 3; ++k) { lh[k * n + i] = l[k]; a0[k * n + i] = a[k]; inhib[k * n + i] = q[k]; }
    }
  });
  // DIR inhibitor diffuses through the emulsion before it acts (James, Theory of the Photographic
  // Process, edge/interimage effects): blur the interlayer inhibition, and add self-inhibition from the
  // layer's own diffused inhibitor -- zero on uniform areas, so the datasheet sensitometry is untouched.
  std::vector<float> spread;
  const double sigma_dir = p.dir_diffusion_um / pitch_um;
  const bool dir = p.dir_diffusion_um > 0 && sigma_dir > 0.05;
  if (dir) {
    spread = a0;
    for (int k = 0; k < 3; ++k) {
      gaussian_blur(inhib.data() + k * n, w, h, sigma_dir, threads);
      gaussian_blur(spread.data() + k * n, w, h, sigma_dir, threads);
    }
  }
  const float self = pipe.self_inhibition();
  run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
    std::vector<float> scratch(L);
    for (std::size_t i = s; i < e; ++i) {
      float l[3], q[3], a[3];
      for (int k = 0; k < 3; ++k) {
        l[k] = lh[k * n + i];
        q[k] = inhib[k * n + i];
        if (dir) q[k] += self * (spread[k * n + i] - a0[k * n + i]);
      }
      pipe.develop(l, q, a);
      pipe.finish(a, out + 3 * i, scratch.data());
    }
  });
}

}  // namespace ffe
