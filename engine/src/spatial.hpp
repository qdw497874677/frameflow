// Full-resolution (spatial) render path: effects that depend on neighbouring pixels and so cannot live
// in a 3D LUT -- DIR inhibitor diffusion (edge effects), film grain and halation.
#pragma once
#include <cstdint>

#include "film_model.hpp"

namespace ffe {

struct SpatialParams {
  double film_format_mm = 36.0;   // long edge of the frame on film (135 = 36 mm); sets the pixel pitch
  double dir_diffusion_um = 0.0;  // DIR inhibitor diffusion length (Gaussian sigma on film); 0 = off
};

bool spatial_active(const SpatialParams& p);

// in/out: interleaved linear RGB, w x h. Equals pipe.process() pixel-wise when no effect is active.
void render_spatial(const FilmPipeline& pipe, const float* in, float* out, int w, int h, const SpatialParams& p,
                    unsigned threads);

// Gaussian blur of a w x h float plane in place, edges clamped. Small sigma: exact separable kernel;
// larger: three box passes (Wells 1986; widths after Kovesi 2010).
void gaussian_blur(float* plane, int w, int h, double sigma_px, unsigned threads);

}  // namespace ffe
