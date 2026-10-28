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

// counter-based hash (splitmix64 finaliser): the noise does not depend on threading or tiling
inline std::uint64_t mix(std::uint64_t z) {
  z += 0x9E3779B97F4A7C15ull;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  return z ^ (z >> 31);
}
inline float gauss_noise(std::uint32_t seed, int layer, std::size_t i) {
  const std::uint64_t h = mix(mix(static_cast<std::uint64_t>(seed) * 4 + static_cast<std::uint64_t>(layer)) ^ i);
  const double u1 = (static_cast<double>(h >> 11) + 0.5) * 0x1.0p-53;
  const double u2 = static_cast<double>(mix(h) >> 11) * 0x1.0p-53;
  return static_cast<float>(std::sqrt(-2.0 * std::log(u1)) * std::cos(6.283185307179586 * u2));
}

constexpr int kGrainTable = 256;

}  // namespace

double boolean_grain_variance(double u, double r, double sigma) {
  if (!(u > 0) || !(u < 1)) return 0;
  if (!(sigma > 1e-9)) return u * (1 - u);
  const double lambda = -std::log(1 - u) / (M_PI * r * r);
  const double q2 = (1 - u) * (1 - u);
  const int steps = 400;
  const double h = 2 * r / steps, s2 = 4 * sigma * sigma;
  double var = 0;
  for (int j = 0; j < steps; ++j) {  // midpoint rule over d in [0, 2r)
    const double d = (j + 0.5) * h;
    const double lens = 2 * r * r * std::acos(d / (2 * r)) - 0.5 * d * std::sqrt(4 * r * r - d * d);
    const double cov = q2 * std::expm1(lambda * lens);
    var += cov * std::exp(-d * d / s2) / (M_PI * s2) * 2 * M_PI * d * h;
  }
  return var;
}

void gaussian_blur(float* plane, int w, int h, double sigma_px, unsigned threads) {
  if (!(sigma_px > 0.05)) return;
  const std::size_t W = static_cast<std::size_t>(w), H = static_cast<std::size_t>(h);
  blur_lines(plane, H, W, 1, [W](std::size_t l) { return l * W; }, sigma_px, threads);
  blur_lines(plane, W, H, W, [](std::size_t l) { return l; }, sigma_px, threads);
}

bool spatial_active(const SpatialParams& p) { return p.dir_diffusion_um > 0 || p.grain > 0 || p.halation > 0; }

void render_spatial(const FilmPipeline& pipe, const float* in, float* out, int w, int h, const SpatialParams& p,
                    unsigned threads) {
  const std::size_t n = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  const double pitch_um = p.film_format_mm * 1000.0 / std::max(w, h);
  const int L = pipe.wavelengths();
  // planar buffers: log H, undeveloped dye, local interlayer inhibition
  std::vector<float> lh(3 * n), a0(3 * n), inhib(3 * n);
  // Halation (James, Theory of the Photographic Process, halation/irradiation): light crossing the
  // emulsion reflects off the base and re-exposes it in a wide halo, mostly in the red-sensitive layer
  // nearest the base (Kodak's datasheets: no rem-jet on Portra, so some halation remains).
  // E'_k = (E_k + s w_k blur(E_k)) / (1 + s w_k): energy-conserving, so mid-grey sensitometry holds on
  // uniform areas and only strong local highlights glow.
  std::vector<float> exp_planes;
  if (p.halation > 0) {
    exp_planes.resize(3 * n);
    run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
      for (std::size_t i = s; i < e; ++i) {
        float ex[3];
        pipe.layer_exposure(in + 3 * i, ex);
        for (int k = 0; k < 3; ++k) exp_planes[k * n + i] = ex[k];
      }
    });
    const double sigma_h = p.halation_radius_mm * 1000.0 / pitch_um;
    for (int k = 0; k < 3; ++k) {
      const float wk = static_cast<float>(p.halation * kHalationWeight[k]);
      if (!(wk > 0)) continue;
      float* plane = exp_planes.data() + k * n;
      std::vector<float> halo(plane, plane + n);
      gaussian_blur(halo.data(), w, h, sigma_h, threads);
      run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
        for (std::size_t i = s; i < e; ++i) plane[i] = (plane[i] + wk * halo[i]) / (1 + wk);
      });
    }
  }
  run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
    for (std::size_t i = s; i < e; ++i) {
      float ex[3], l[3], a[3], q[3];
      if (p.halation > 0) {
        for (int k = 0; k < 3; ++k) ex[k] = exp_planes[k * n + i];
      } else {
        pipe.layer_exposure(in + 3 * i, ex);
      }
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
  std::vector<float> dye(3 * n);
  run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
    for (std::size_t i = s; i < e; ++i) {
      float l[3], q[3], a[3];
      for (int k = 0; k < 3; ++k) {
        l[k] = lh[k * n + i];
        q[k] = inhib[k * n + i];
        if (dir) q[k] += self * (spread[k * n + i] - a0[k * n + i]);
      }
      pipe.develop(l, q, a);
      for (int k = 0; k < 3; ++k) dye[k * n + i] = a[k];
    }
  });
  if (p.grain > 0) {
    // Film grain (Newson et al. 2017): each layer's developed dye is a Boolean model of dye clouds of
    // radius r, with coverage u = a / a_max (intensity lambda = -ln(1-u) / (pi r^2)), seen through the
    // scanner's Gaussian aperture (sigma = half a pixel). Fast approximation: the per-pixel variance is
    // the exact Boolean-model variance (tabulated over u); the spatial correlation comes from seeded
    // white noise blurred to the matching width. Mean density is preserved.
    const double sigma_f = 0.5;  // px
    for (int k = 0; k < 3; ++k) {
      const double r = kGrainRadiusUm[k] * p.grain / pitch_um;  // px
      std::vector<float> sd(kGrainTable + 1);
      for (int t = 0; t <= kGrainTable; ++t)
        sd[t] = static_cast<float>(std::sqrt(boolean_grain_variance(static_cast<double>(t) / kGrainTable, r, sigma_f)));
      std::vector<float> noise(n);
      run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
        for (std::size_t i = s; i < e; ++i) noise[i] = gauss_noise(p.grain_seed, k, i);
      });
      const double sigma_n = std::sqrt(0.25 * r * r + sigma_f * sigma_f);
      gaussian_blur(noise.data(), w, h, sigma_n, threads);
      double ss = 0;  // renormalise the blurred noise to unit variance
      for (std::size_t i = 0; i < n; ++i) ss += static_cast<double>(noise[i]) * noise[i];
      const float norm = ss > 0 ? static_cast<float>(1.0 / std::sqrt(ss / static_cast<double>(n))) : 0.0f;
      const float amax = pipe.dye_max(k);
      float* plane = dye.data() + k * n;
      run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
        for (std::size_t i = s; i < e; ++i) {
          const float u = std::clamp(plane[i] / amax, 0.0f, 1.0f);
          const float ft = u * kGrainTable;
          const int t = std::min(kGrainTable - 1, static_cast<int>(ft));
          const float sdev = sd[t] + (sd[t + 1] - sd[t]) * (ft - t);
          plane[i] = amax * std::clamp(u + sdev * noise[i] * norm, 0.0f, 1.0f);
        }
      });
    }
  }
  run_parallel(n, threads, [&](std::size_t s, std::size_t e) {
    std::vector<float> scratch(L);
    for (std::size_t i = s; i < e; ++i) {
      float a[3] = {dye[i], dye[n + i], dye[2 * n + i]};
      pipe.finish(a, out + 3 * i, scratch.data());
    }
  });
}

}  // namespace ffe
