// Full-resolution (spatial) render path: effects that depend on neighbouring pixels and so cannot live
// in a 3D LUT -- DIR inhibitor diffusion (edge effects), film grain and halation.
#pragma once
#include <cstdint>

#include "film_model.hpp"

namespace ffe {

struct SpatialParams {
  double film_format_mm = 36.0;   // long edge of the frame on film (135 = 36 mm); sets the pixel pitch
  double dir_diffusion_um = 0.0;  // DIR inhibitor diffusion length (Gaussian sigma on film); 0 = off
  double grain = 0.0;             // grain size multiplier on the per-layer dye-cloud radii; 0 = off
  std::uint32_t grain_seed = 0;   // grain is a pure function of (seed, layer, x, y)
  double halation = 0.0;          // fraction of red-layer exposure scattered back from the base; 0 = off
  double halation_radius_mm = 0.25;  // Gaussian sigma of the halo on film
};

// Relative halation weight of the blue, green, red layer (red sits next to the base).
inline constexpr double kHalationWeight[3] = {0.0, 0.25, 1.0};

// Effective dye-cloud radius (um on film) of the blue, green, red layer at grain = 1, chosen so the
// 48 um-aperture RMS granularity at mid density is ~0.005 (typical ISO 400 colour negative). Assumption,
// see PROVENANCE.
inline constexpr double kGrainRadiusUm[3] = {0.14, 0.11, 0.12};

// Variance of a Boolean model of discs of radius r (coverage u) seen through a Gaussian filter of
// std sigma (Newson et al. 2017): integral of the coverage covariance against the filter's
// autocorrelation. Lengths in the same unit. sigma = 0 gives u(1-u).
double boolean_grain_variance(double u, double r, double sigma);

bool spatial_active(const SpatialParams& p);

// in/out: interleaved linear RGB, w x h. Equals pipe.process() pixel-wise when no effect is active.
void render_spatial(const FilmPipeline& pipe, const float* in, float* out, int w, int h, const SpatialParams& p,
                    unsigned threads);

// Gaussian blur of a w x h float plane in place, edges clamped. Small sigma: exact separable kernel;
// larger: three box passes (Wells 1986; widths after Kovesi 2010).
void gaussian_blur(float* plane, int w, int h, double sigma_px, unsigned threads);

}  // namespace ffe
