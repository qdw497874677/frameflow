#include <algorithm>
#include <cmath>
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
