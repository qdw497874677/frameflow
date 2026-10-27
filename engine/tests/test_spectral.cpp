#include <algorithm>

#include "check.hpp"
#include "spectral.hpp"

using namespace ffe;

static Vec3 chroma(const Vec3& xyz) {
  double s = xyz[0] + xyz[1] + xyz[2];
  return {xyz[0] / s, xyz[1] / s, 0};
}

TEST(cmf_peaks_and_equal_energy_white) {
  Grid g;
  auto cmf = cie1931_cmf(g);
  auto peak = std::max_element(cmf[1].begin(), cmf[1].end()) - cmf[1].begin();
  CHECK_NEAR(g.at(static_cast<int>(peak)), 555, 5);
  CHECK_NEAR(cmf[1][peak], 1.0, 0.03);
  Spectrum flat(g.count, 1.0);
  Vec3 c = chroma(white_xyz(g, flat, cmf));
  CHECK_NEAR(c[0], 1.0 / 3, 0.003);
  CHECK_NEAR(c[1], 1.0 / 3, 0.003);
}

TEST(planck_locus_matches_published_chromaticities) {
  Grid g;
  auto cmf = cie1931_cmf(g);
  // CIE 1931 Planckian locus: 2856 K ~ (0.4476, 0.4074) (illuminant A), 6504 K ~ (0.3135, 0.3236)
  Vec3 a = chroma(white_xyz(g, planck(g, 2856), cmf));
  CHECK_NEAR(a[0], 0.4476, 0.003);
  CHECK_NEAR(a[1], 0.4074, 0.003);
  Vec3 d = chroma(white_xyz(g, planck(g, 6504), cmf));
  CHECK_NEAR(d[0], 0.3135, 0.003);
  CHECK_NEAR(d[1], 0.3236, 0.003);
}

TEST(srgb_matrices_and_transfer) {
  Mat3 m = srgb_to_xyz();
  CHECK_NEAR(m[1][0], 0.2126, 1e-3);
  CHECK_NEAR(m[1][1], 0.7152, 1e-3);
  CHECK_NEAR(m[1][2], 0.0722, 1e-3);
  Mat3 id = mul(m, xyz_to_srgb());
  for (int r = 0; r < 3; ++r)
    for (int c = 0; c < 3; ++c) CHECK_NEAR(id[r][c], r == c ? 1 : 0, 1e-9);
  for (double v : {0.0, 0.002, 0.04, 0.18, 0.5, 1.0}) CHECK_NEAR(srgb_decode(srgb_encode(v)), v, 1e-12);
  CHECK_NEAR(srgb_encode(0.18), 0.4614, 1e-3);
  CHECK_NEAR(srgb_encode(2.0), 1.0, 1e-12);
}

TEST(bradford_maps_whites) {
  Vec3 a{1.0985, 1.0, 0.3558};  // illuminant A
  Mat3 m = bradford(a, d65_white());
  Vec3 w = mul(m, a), d = d65_white();
  for (int k = 0; k < 3; ++k) CHECK_NEAR(w[k], d[k], 1e-9);
  Mat3 id = bradford(d, d);
  for (int r = 0; r < 3; ++r)
    for (int c = 0; c < 3; ++c) CHECK_NEAR(id[r][c], r == c ? 1 : 0, 1e-9);
}

TEST(upsampling_basis_is_physical_and_exact) {
  Grid g;
  auto cmf = cie1931_cmf(g);
  for (double kelvin : {3200.0, 5500.0, 6504.0}) {
    UpsamplingBasis up = solve_upsampling_basis(g, planck(g, kelvin), cmf);
    CHECK(up.max_error < 1e-4);
    double roughness = 0;
    for (int i = 0; i < g.count; ++i) {
      double sum = 0;
      for (int k = 0; k < 3; ++k) {
        CHECK(up.basis[k][i] >= -1e-9 && up.basis[k][i] <= 1 + 1e-9);
        sum += up.basis[k][i];
        if (i > 0) roughness = std::max(roughness, std::abs(up.basis[k][i] - up.basis[k][i - 1]));
      }
      CHECK_NEAR(sum, 1.0, 1e-6);  // white reflects everything: rgb (1,1,1) -> flat 1
    }
    CHECK(roughness < 0.25);  // smooth spectra, no single-sample spikes
  }
}

TEST_MAIN
