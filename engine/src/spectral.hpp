// Spectral primitives: wavelength grid, colour matching functions, illuminants,
// colour-space matrices and RGB -> reflectance upsampling.
#pragma once
#include <array>
#include <vector>

namespace ffe {

using Vec3 = std::array<double, 3>;
using Mat3 = std::array<Vec3, 3>;

Vec3 mul(const Mat3& m, const Vec3& v);
Mat3 mul(const Mat3& a, const Mat3& b);
Mat3 inverse(const Mat3& m);
Mat3 diag(const Vec3& v);

// Uniform wavelength grid. All spectra in the engine share one grid.
struct Grid {
  double start = 380.0;
  double step = 5.0;
  int count = 81;
  double at(int i) const { return start + step * i; }
};

using Spectrum = std::vector<double>;

// CIE 1931 2-degree observer, multi-lobe analytic approximation of
// Wyman, Sloan & Shirley (JCGT 2(2), 2013).
std::array<Spectrum, 3> cie1931_cmf(const Grid& g);

// Planck black-body spectral radiance (relative, normalised to 1 at 560 nm).
Spectrum planck(const Grid& g, double kelvin);

// XYZ of an illuminant with Y normalised to 1.
Vec3 white_xyz(const Grid& g, const Spectrum& illuminant, const std::array<Spectrum, 3>& cmf);

// sRGB (IEC 61966-2-1): linear RGB <-> XYZ for a D65 white, and the transfer function.
Mat3 srgb_to_xyz();
Mat3 xyz_to_srgb();
Vec3 d65_white();
double srgb_decode(double v);
double srgb_encode(double v);

// Bradford chromatic adaptation (Lam 1985) from one white to another.
Mat3 bradford(const Vec3& from_white, const Vec3& to_white);

// Linear basis for RGB -> reflectance upsampling.
//
// Three non-negative spectra b_r, b_g, b_b with b_r + b_g + b_b = 1 at every
// wavelength and values in [0, 1], so every RGB in [0,1]^3 maps to a physically
// valid reflectance and RGB (1,1,1) maps to the perfect white reflector. Under
// `illuminant`, each basis spectrum reproduces the corresponding sRGB primary
// (chromatically adapted from D65 to the illuminant white). The smoothest such
// basis (minimal squared first differences) is found with an ADMM quadratic
// program. Idea after Mallett & Yuksel (EGSR 2019); formulation and solver are ours.
struct UpsamplingBasis {
  std::array<Spectrum, 3> basis;
  double max_error = 0.0;  // worst XYZ error of the primaries
};
UpsamplingBasis solve_upsampling_basis(const Grid& g, const Spectrum& illuminant,
                                       const std::array<Spectrum, 3>& cmf);

}  // namespace ffe
