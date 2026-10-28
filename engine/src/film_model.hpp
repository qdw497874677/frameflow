// Physically based colour-negative -> print -> scan pipeline (per pixel, no spatial effects).
//
//   linear sRGB --(upsampling basis)--> scene reflectance x scene illuminant
//     --(negative spectral sensitivity)--> layer exposures --(characteristic curves)-->
//     dye amounts --(dye spectral densities + D-min)--> negative transmittance
//     x printer lamp --(paper sensitivity)--> paper exposures --(paper curves)-->
//     paper dye amounts --> print reflectance x viewing illuminant --(CIE 1931)--> XYZ
//     --(adapt paper white to D65)--> linear sRGB
#pragma once
#include <array>
#include <memory>
#include <string>
#include <vector>

#include "spectral.hpp"
#include "stock.hpp"

namespace ffe {

struct RenderParams {
  double exposure_ev = 0.0;      // camera exposure relative to normal
  double scene_kelvin = 5500.0;  // illuminant the RGB scene is lit by (daylight-balanced film)
  double printer_kelvin = 3200.0;
  double viewing_kelvin = 6504.0;
  double print_grey = 0.18;      // linear output a normally exposed 18% grey prints to
  double dir_strength = 1.0;     // interlayer (DIR coupler) inhibition, 1 = cancels layer crosstalk at grey
  bool scan_black_point = true;  // scanner sets per-channel black at paper D-max (white is paper base)
  // Input is display-referred (camera JPEG / sRGB): undo the SDR reference OOTF (luminance power,
  // ITU-R BT.2390 / BT.709+BT.1886 end-to-end gamma ~1.2) below grey to estimate scene-referred light,
  // easing to slope 1 within ~1 EV above grey so diffuse white stays put. 1 = input is scene-linear.
  double input_gamma = 1.2;
  // Camera veiling glare (ISO 18844): uniform light added at the film plane, fraction of scene white.
  double camera_flare = 0.01;
};

// A characteristic curve sampled on a uniform log-exposure grid.
class Curve {
 public:
  Curve() = default;
  Curve(double x0, double dx, std::vector<float> y, bool extrapolate_high);
  float operator()(float x) const;
  float front() const { return y_.front(); }

 private:
  float x0_ = 0, inv_dx_ = 1, slope_hi_ = 0;
  bool extrapolate_ = false;
  std::vector<float> y_;
};

struct PipelineReport {
  double upsampling_error = 0;
  Vec3 grey_negative_status{};  // Status M densities of the negative for a normally exposed grey
  Vec3 dmin_status{};           // Status M densities of the D-min spectrum
  Vec3 printer_log_gain{};      // log10 printer light per layer (the balance found)
  Vec3 grey_out{};              // linear RGB of an 18% grey after the full chain
  Vec3 paper_black{};
  Mat3 interlayer{};            // fitted DIR inhibition matrix (log H per unit dye amount)
  Mat3 crosstalk_before{};      // grey response without / with interlayer effects (layer-aligned)
  Mat3 crosstalk_after{};
  std::array<double, 5> crosstalk_ramp{};  // worst |off-diagonal| at -2, -1, 0, +1, +2 EV after DIR
  double system_gamma = 0;      // d log10 output / d log10 input (neutral, at normal grey)
  int balance_iterations = 0;
};

class FilmPipeline {
 public:
  FilmPipeline(const Stock& negative, const Stock& paper, const RenderParams& params);

  // in/out: interleaved linear RGB floats, n pixels.
  void process(const float* in, float* out, std::size_t n) const;
  Vec3 process(const Vec3& rgb) const;
  // log10 paper exposure per layer before printer balance ("printing density" = minus this).
  Vec3 printing_log_exposure(const Vec3& rgb) const;
  const PipelineReport& report() const { return report_; }

  // Stages of process(), exposed for the spatial (full-resolution) render path:
  //   layer_exposure -> [halation] -> log_exposure -> undeveloped -> [inhibitor diffusion] -> develop
  //   -> [grain] -> finish.  Chained without the bracketed steps they equal process() exactly.
  void layer_exposure(const float* in, float* e) const;  // linear layer exposure, scene white ~ 1
  void log_exposure(const float* e, float* lh) const;
  // dye amounts before DIR inhibition, and the local interlayer inhibition (log H) each layer receives
  void undeveloped(const float* lh, float* a, float* inhibit) const;
  void develop(const float* lh, const float* inhibit, float* a) const;
  void finish(const float* a, float* out, float* scratch /* L floats */) const;
  int wavelengths() const { return L_; }
  float dye_max(int k) const { return neg_dye_max_[k]; }
  float self_inhibition() const { return dir_self_; }

 private:
  void print_log_from_dye(const float* a, float* logp, float* trans) const;
  void process_one(const float* in, float* out, float* scratch) const;
  void print_log_exposure(const float* in, float* logp, float* scratch) const;
  void balance_printer(const RenderParams& params);
  void fit_interlayer(double strength);
  Mat3 grey_response(double ev = 0) const;  // d logP_layer / d log10 input channel (layer-aligned), at normal grey

  int L_ = 0;
  float ootf_inv_exp_ = 0;   // 1/input_gamma - 1
  float flare_ = 0, flare_norm_ = 1;
  Mat3 exposure_{};          // linear sRGB -> relative layer exposure (1 = scene white)
  float log_h_grey_offset_ = 0;
  double exposure_ev_ = 0;  // log H of the layer exposure of white
  std::array<Curve, 3> neg_dye_;  // dye amount vs log H
  std::array<float, 3> neg_dye_max_{};
  float dir_self_ = 0;  // self-inhibition (log H per unit dye amount) for the spatial edge effect
  std::array<std::array<float, 3>, 3> dir_{};  // inhibition of layer k by developed dye of layer j
  std::vector<float> neg_dmin_;   // L
  std::vector<float> neg_dye_density_;  // 3 x L
  std::vector<float> print_weight_;     // 3 x L : lamp x paper sensitivity
  std::array<float, 3> print_gain_log_{};
  std::array<Curve, 3> paper_dye_;
  std::array<float, 3> paper_mid_log_h_{};
  std::vector<float> paper_dye_density_;  // 3 x L
  std::vector<float> view_weight_;        // 3 x L : viewing illuminant x CMF, normalised
  Mat3 output_{};                         // XYZ -> linear sRGB incl. paper-white adaptation
  Grid grid_{};
  std::array<float, 3> black_{};          // linear output of paper D-max (subtracted when scanning)
  std::array<float, 3> black_scale_{1.0f, 1.0f, 1.0f};
  PipelineReport report_;
};

// Analytical dye amounts that reproduce integral (status) densities, per log-H sample.
std::array<std::vector<double>, 3> analytical_dye_curves(const Stock& s, const std::array<Spectrum, 3>& status);
Vec3 status_density(const Grid& g, const Spectrum& density, const std::array<Spectrum, 3>& status);

}  // namespace ffe
