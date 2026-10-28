#include <algorithm>
#include <cmath>
#include <random>
#include <vector>

#include "check.hpp"
#include "spatial.hpp"

using namespace ffe;

namespace {
const StockLibrary& library() {
  static StockLibrary lib(FFE_DATA_DIR);
  return lib;
}
const FilmPipeline& pipe() {
  static FilmPipeline p(*library().find("portrait400"), *library().find("premierpaper"), RenderParams{});
  return p;
}
std::vector<float> step_image(int w, int h, float lo, float hi) {
  std::vector<float> v(3 * w * h);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x)
      for (int c = 0; c < 3; ++c) v[3 * (y * w + x) + c] = x < w / 2 ? lo : hi;
  return v;
}
}  // namespace

TEST(blur_keeps_constants_and_matches_gaussian_variance) {
  for (double sigma : {1.0, 2.5, 6.0, 15.0}) {
    const int w = 201, h = 3;
    std::vector<float> flat(w * h, 0.7f);
    gaussian_blur(flat.data(), w, h, sigma, 2);
    for (float v : flat) CHECK_NEAR(v, 0.7, 1e-5);
    std::vector<float> d(w * h, 0.0f);
    for (int y = 0; y < h; ++y) d[y * w + 100] = 1.0f;
    gaussian_blur(d.data(), w, h, sigma, 2);
    double m0 = 0, m2 = 0;
    for (int x = 0; x < w; ++x) { m0 += d[w + x]; m2 += d[w + x] * (x - 100.0) * (x - 100.0); }
    CHECK_NEAR(m0, 1.0, 1e-4);
    CHECK_NEAR(std::sqrt(m2 / m0), sigma, 0.06 * sigma + 0.05);
  }
}

TEST(spatial_path_without_effects_equals_per_pixel) {
  const int w = 16, h = 8;
  std::vector<float> in(3 * w * h), out(in.size()), ref(in.size());
  for (std::size_t i = 0; i < in.size(); ++i) in[i] = static_cast<float>((i * 37 % 101) / 100.0);
  render_spatial(pipe(), in.data(), out.data(), w, h, SpatialParams{}, 2);
  pipe().process(in.data(), ref.data(), w * h);
  for (std::size_t i = 0; i < in.size(); ++i) CHECK_NEAR(out[i], ref[i], 1e-6);
}

TEST(dir_diffusion_leaves_uniform_areas_and_sharpens_edges) {
  SpatialParams sp;
  sp.dir_diffusion_um = 15;
  sp.film_format_mm = 2.0;  // 128 px over 2 mm: ~16 um pitch
  const int w = 128, h = 4;
  auto flat = step_image(w, h, 0.2f, 0.2f);
  std::vector<float> out(flat.size()), ref(flat.size());
  render_spatial(pipe(), flat.data(), out.data(), w, h, sp, 2);
  pipe().process(flat.data(), ref.data(), w * h);
  for (std::size_t i = 0; i < out.size(); ++i) CHECK_NEAR(out[i], ref[i], 1e-5);

  auto edge = step_image(w, h, 0.04f, 0.4f);
  render_spatial(pipe(), edge.data(), out.data(), w, h, sp, 2);
  auto g = [&](int x) { return out[3 * (w + x) + 1]; };
  CHECK(g(w / 2) > g(w - 4) * 1.01);      // bright side brightens at the edge (Mackie line / acutance)
  CHECK(g(w / 2 - 1) < g(3) * 0.99);      // dark side darkens
  CHECK_NEAR(g(w - 4), ref[0] * 0 + pipe().process(Vec3{0.4, 0.4, 0.4})[1], 2e-3);  // far field unchanged
}

TEST_MAIN

TEST(boolean_variance_matches_monte_carlo) {
  // Boolean model of discs (radius 3 px) on a 512^2 grid, Gaussian-filtered (sigma 2 px)
  const int N = 512;
  const double r = 3.0, sigma = 2.0;
  std::mt19937_64 rng(42);
  for (double u : {0.2, 0.5, 0.8}) {
    const double lambda = -std::log(1 - u) / (M_PI * r * r);
    std::poisson_distribution<int> pois(lambda * N * N);
    std::uniform_real_distribution<double> uni(0, N);
    std::vector<float> img(N * N, 0.0f);
    const int count = pois(rng);
    for (int c = 0; c < count; ++c) {
      const double cx = uni(rng), cy = uni(rng);
      for (int y = int(cy - r) - 1; y <= int(cy + r) + 1; ++y)
        for (int x = int(cx - r) - 1; x <= int(cx + r) + 1; ++x) {
          const double dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r * r) img[((y + N) % N) * N + (x + N) % N] = 1.0f;  // periodic
        }
    }
    double mean0 = 0;
    for (float v : img) mean0 += v;
    mean0 /= N * N;
    CHECK_NEAR(mean0, u, 0.02);
    ffe::gaussian_blur(img.data(), N, N, sigma, 1);
    double m = 0, v2 = 0;
    const int b = 16;  // skip clamped borders
    int cnt = 0;
    for (int y = b; y < N - b; ++y)
      for (int x = b; x < N - b; ++x) { m += img[y * N + x]; v2 += double(img[y * N + x]) * img[y * N + x]; ++cnt; }
    m /= cnt;
    const double var = v2 / cnt - m * m;
    CHECK_NEAR(var / ffe::boolean_grain_variance(u, r, sigma), 1.0, 0.12);
  }
  CHECK_NEAR(ffe::boolean_grain_variance(0.3, 2.0, 0.0), 0.21, 1e-12);
}

TEST(grain_is_seeded_mean_preserving_and_density_dependent) {
  const auto& pl = pipe();
  const int w = 192, h = 64;
  std::vector<float> in(3 * w * h);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      const float v = x < w / 3 ? 0.02f : x < 2 * w / 3 ? 0.18f : 0.9f;  // shadow, grey, highlight bands
      for (int c = 0; c < 3; ++c) in[3 * (y * w + x) + c] = v;
    }
  ffe::SpatialParams p;
  p.film_format_mm = 2.0;  // ~10 um pixels: grain visible at this tiny size
  std::vector<float> flat(in.size()), g1(in.size()), g2(in.size()), g3(in.size());
  ffe::render_spatial(pl, in.data(), flat.data(), w, h, p, 2);
  p.grain = 1.0;
  p.grain_seed = 7;
  ffe::render_spatial(pl, in.data(), g1.data(), w, h, p, 1);
  ffe::render_spatial(pl, in.data(), g2.data(), w, h, p, 4);
  CHECK(g1 == g2);  // deterministic regardless of threads
  p.grain_seed = 8;
  ffe::render_spatial(pl, in.data(), g3.data(), w, h, p, 2);
  CHECK(!(g1 == g3));
  double sd[3];
  for (int band = 0; band < 3; ++band) {
    double m = 0, mf = 0, v = 0;
    int cnt = 0;
    for (int y = 0; y < h; ++y)
      for (int x = band * w / 3 + 4; x < (band + 1) * w / 3 - 4; ++x) {
        const std::size_t i = 3 * (y * w + x) + 1;
        m += g1[i]; mf += flat[i]; v += double(g1[i] - flat[i]) * (g1[i] - flat[i]); ++cnt;
      }
    m /= cnt; mf /= cnt;
    sd[band] = std::sqrt(v / cnt);
    CHECK_NEAR(m / mf, 1.0, 0.08);  // mean roughly preserved in output linear light
    CHECK(sd[band] > 1e-4);
  }
  CHECK(std::fabs(sd[0] - sd[1]) > 0.2 * std::min(sd[0], sd[1]) || std::fabs(sd[2] - sd[1]) > 0.2 * std::min(sd[2], sd[1]));
}
