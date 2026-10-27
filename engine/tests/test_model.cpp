#include <algorithm>
#include <cmath>

#include "check.hpp"
#include "film_model.hpp"

using namespace ffe;

namespace {
const StockLibrary& library() {
  static StockLibrary lib(FFE_DATA_DIR);
  return lib;
}
FilmPipeline make(RenderParams p = {}) {
  return FilmPipeline(*library().find("portrait400"), *library().find("premierpaper"), p);
}
Vec3 grey(double v) { return {v, v, v}; }
}  // namespace

TEST(library_loads_stocks) {
  CHECK(library().find("portrait400") != nullptr);
  CHECK(library().find("premierpaper") != nullptr);
  CHECK(library().find("nope") == nullptr);
  CHECK(library().find("portrait400")->kind == StockKind::Negative);
}

TEST(normal_grey_prints_to_target) {
  FilmPipeline p = make();
  const auto& r = p.report();
  CHECK(r.upsampling_error < 1e-4);
  CHECK(r.balance_iterations < 40);
  for (int k = 0; k < 3; ++k) CHECK_NEAR(r.grey_out[k], 0.18, 1e-4);
}

TEST(negative_densities_match_datasheet_scale) {
  // Kodak E-4050: Status M D-min ~ B 0.8 / G 0.63 / R 0.2; grey card about 0.65-0.9 above it.
  const auto& r = make().report();
  CHECK_NEAR(r.dmin_status[0], 0.80, 0.08);
  CHECK_NEAR(r.dmin_status[1], 0.63, 0.08);
  CHECK_NEAR(r.dmin_status[2], 0.20, 0.08);
  CHECK(r.grey_negative_status[0] > r.grey_negative_status[1]);
  CHECK(r.grey_negative_status[1] > r.grey_negative_status[2]);
  CHECK_NEAR(r.grey_negative_status[2], 0.85, 0.1);
}

TEST(printing_densities_are_parallel_on_grey_ramp) {
  // A negative designed for this paper prints a grey scale with (nearly) parallel layer slopes.
  FilmPipeline p = make();
  Vec3 lo = p.printing_log_exposure(grey(0.18 / 4)), hi = p.printing_log_exposure(grey(0.18 * 4));
  double s0 = (lo[0] - hi[0]) / 4, s1 = (lo[1] - hi[1]) / 4, s2 = (lo[2] - hi[2]) / 4;
  CHECK(s1 > 0.1);
  CHECK_NEAR(s0 / s1, 1.0, 0.05);
  CHECK_NEAR(s2 / s1, 1.0, 0.05);
}

TEST(grey_ramp_is_monotone_and_near_neutral) {
  FilmPipeline p = make();
  Vec3 prev{-1, -1, -1};
  for (double ev = -6; ev <= 3.01; ev += 0.25) {
    Vec3 o = p.process(grey(0.18 * std::pow(2.0, ev)));
    for (int k = 0; k < 3; ++k) CHECK(o[k] >= prev[k] - 1e-6);
    prev = o;
    // neutral within ~5/255 in display (sRGB-encoded) values
    double e[3] = {srgb_encode(o[0]), srgb_encode(o[1]), srgb_encode(o[2])};
    double m = (e[0] + e[1] + e[2]) / 3;
    for (int k = 0; k < 3; ++k) CHECK(std::abs(e[k] - m) < 0.02);
  }
  Vec3 black = p.process(grey(0));
  for (int k = 0; k < 3; ++k) CHECK(std::abs(black[k]) < 1e-3);  // scanner black point at paper D-max
  Vec3 white = p.process(grey(1));
  for (int k = 0; k < 3; ++k) CHECK(white[k] > 0.85 && white[k] <= 1.0);
}

TEST(interlayer_effects_cancel_grey_crosstalk) {
  const auto& r = make().report();
  double before = 0, after = 0;
  for (int k = 0; k < 3; ++k)
    for (int c = 0; c < 3; ++c)
      if (k != c) {
        before = std::max(before, std::abs(r.crosstalk_before[k][c]));
        after = std::max(after, std::abs(r.crosstalk_after[k][c]));
        CHECK(r.interlayer[k][c] > -0.1);  // inhibition, not (much) facilitation
      }
  CHECK(before > 0.05);  // the datasheet sensitivities overlap
  CHECK(after < 1e-3);
  for (int k = 0; k < 3; ++k) CHECK(r.crosstalk_after[k][k] < -0.2);  // layers still respond to their own light

  RenderParams off;
  off.dir_strength = 0;
  const auto& r0 = make(off).report();
  for (int k = 0; k < 3; ++k)
    for (int c = 0; c < 3; ++c) CHECK(r0.interlayer[k][c] == 0);
  // interimage effects raise saturation of a green
  Vec3 g1 = make().process({0.1, 0.3, 0.05}), g0 = make(off).process({0.1, 0.3, 0.05});
  CHECK(g1[1] / g1[0] > g0[1] / g0[0]);
}

TEST(black_point_can_be_disabled) {
  RenderParams params;
  params.scan_black_point = false;
  FilmPipeline p = make(params);
  Vec3 black = p.process(grey(0));
  for (int k = 0; k < 3; ++k) CHECK_NEAR(black[k], p.report().paper_black[k], 5e-4);  // D-min light keeps paper just short of D-max
  CHECK(p.report().paper_black[1] > 0.001);
}

TEST(exposure_brightens_and_hue_survives) {
  RenderParams over;
  over.exposure_ev = 1;
  FilmPipeline normal = make(), bright = make(over);
  Vec3 g0 = normal.process(grey(0.18)), g1 = bright.process(grey(0.18));
  CHECK(g1[1] > g0[1] * 1.5);
  Vec3 red = normal.process({0.4, 0.05, 0.05});
  CHECK(red[0] > red[1] * 2 && red[0] > red[2] * 2);
  Vec3 blue = normal.process({0.03, 0.06, 0.4});
  CHECK(blue[2] > blue[0] && blue[2] > blue[1]);
}

TEST(batch_matches_single) {
  FilmPipeline p = make();
  float in[6] = {0.1f, 0.2f, 0.3f, 0.9f, 0.5f, 0.0f}, out[6];
  p.process(in, out, 2);
  Vec3 a = p.process(Vec3{0.1, 0.2, 0.3}), b = p.process(Vec3{0.9, 0.5, 0.0});
  for (int k = 0; k < 3; ++k) {
    CHECK_NEAR(out[k], a[k], 1e-4);
    CHECK_NEAR(out[3 + k], b[k], 1e-4);
  }
}

TEST_MAIN
