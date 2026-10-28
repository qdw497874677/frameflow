#include "film_model.hpp"

#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>
#include <stdexcept>

namespace ffe {
namespace {

constexpr float kLog2_10 = 3.32192809488736f;

inline float pow10_neg(float d) { return std::exp2(-kLog2_10 * d); }

Vec3 solve3(const Mat3& a, const Vec3& b) { return mul(inverse(a), b); }

const UpsamplingBasis& cached_basis(const Grid& g, double kelvin) {
  static std::mutex mu;
  static std::map<std::pair<int, long>, UpsamplingBasis> cache;
  std::lock_guard<std::mutex> lock(mu);
  auto key = std::make_pair(g.count * 1000 + static_cast<int>(g.start), std::lround(kelvin));
  auto it = cache.find(key);
  if (it == cache.end()) it = cache.emplace(key, solve_upsampling_basis(g, planck(g, kelvin), cie1931_cmf(g))).first;
  return it->second;
}

}  // namespace

Curve::Curve(double x0, double dx, std::vector<float> y, bool extrapolate_high)
    : x0_(static_cast<float>(x0)), inv_dx_(static_cast<float>(1.0 / dx)), extrapolate_(extrapolate_high), y_(std::move(y)) {
  if (y_.size() < 6) throw std::runtime_error("curve: too few samples");
  std::size_t n = y_.size();
  slope_hi_ = (y_[n - 1] - y_[n - 6]) / 5.0f * inv_dx_;
}

float Curve::operator()(float x) const {
  float t = (x - x0_) * inv_dx_;
  if (!(t > 0.0f)) return y_.front();
  const float last = static_cast<float>(y_.size() - 1);
  if (t >= last) return extrapolate_ ? y_.back() + (t - last) / inv_dx_ * slope_hi_ : y_.back();
  int i = static_cast<int>(t);
  float f = t - static_cast<float>(i);
  return y_[i] + f * (y_[i + 1] - y_[i]);
}

Vec3 status_density(const Grid& g, const Spectrum& density, const std::array<Spectrum, 3>& status) {
  Vec3 out{};
  for (int k = 0; k < 3; ++k) {
    double num = 0, den = 0;
    for (int i = 0; i < g.count; ++i) {
      num += status[k][i] * std::pow(10.0, -density[i]);
      den += status[k][i];
    }
    out[k] = -std::log10(num / den);
  }
  return out;
}

std::array<std::vector<double>, 3> analytical_dye_curves(const Stock& s, const std::array<Spectrum, 3>& status) {
  const Grid& g = s.grid;
  auto densities = [&](const Vec3& a) {
    Spectrum d(g.count);
    for (int i = 0; i < g.count; ++i)
      d[i] = s.dmin[i] + a[0] * s.dye_density[0][i] + a[1] * s.dye_density[1][i] + a[2] * s.dye_density[2][i];
    return status_density(g, d, status);
  };
  std::array<std::vector<double>, 3> out;
  Vec3 a{0, 0, 0};
  for (std::size_t n = 0; n < s.log_h.size(); ++n) {
    Vec3 target{s.density[0][n], s.density[1][n], s.density[2][n]};
    for (int it = 0; it < 30; ++it) {
      Vec3 f = densities(a);
      Vec3 r{f[0] - target[0], f[1] - target[1], f[2] - target[2]};
      if (std::max({std::abs(r[0]), std::abs(r[1]), std::abs(r[2])}) < 1e-7) break;
      Mat3 J{};
      for (int c = 0; c < 3; ++c) {
        Vec3 ap = a;
        ap[c] += 1e-5;
        Vec3 fp = densities(ap);
        for (int k = 0; k < 3; ++k) J[k][c] = (fp[k] - f[k]) / 1e-5;
      }
      Vec3 step = solve3(J, r);
      for (int c = 0; c < 3; ++c) a[c] -= step[c];
    }
    // channel k of the status densitometer mostly sees dye k (B<->yellow, G<->magenta, R<->cyan)
    for (int k = 0; k < 3; ++k) out[k].push_back(std::max(a[k], 0.0));
  }
  return out;
}

FilmPipeline::FilmPipeline(const Stock& neg, const Stock& paper, const RenderParams& params) {
  if (neg.kind != StockKind::Negative || paper.kind != StockKind::Paper)
    throw std::invalid_argument("pipeline needs a negative and a paper");
  if (neg.grid.count != paper.grid.count || neg.grid.start != paper.grid.start || neg.grid.step != paper.grid.step)
    throw std::invalid_argument("stocks use different wavelength grids");
  const Grid& g = neg.grid;
  grid_ = g;
  L_ = g.count;
  const auto cmf = cie1931_cmf(g);

  // 1) camera exposure: scene reflectance basis under the scene illuminant
  const UpsamplingBasis& up = cached_basis(g, params.scene_kelvin);
  report_.upsampling_error = up.max_error;
  const Spectrum scene = planck(g, params.scene_kelvin);
  for (int k = 0; k < 3; ++k) {
    double white = 0;
    std::array<double, 3> col{};
    for (int i = 0; i < L_; ++i) {
      double w = scene[i] * std::pow(10.0, neg.log_sensitivity[k][i]);
      white += w;
      for (int j = 0; j < 3; ++j) col[j] += up.basis[j][i] * w;
    }
    for (int j = 0; j < 3; ++j) exposure_[k][j] = col[j] / white;
  }
  // a normally exposed 18% grey lands on the datasheet's reference log H
  ootf_inv_exp_ = static_cast<float>(1.0 / params.input_gamma - 1.0);
  flare_ = static_cast<float>(params.camera_flare);
  flare_norm_ = static_cast<float>(0.18 / (0.18 + params.camera_flare));  // metering keeps grey on log H ref
  exposure_ev_ = params.exposure_ev;
  log_h_grey_offset_ = static_cast<float>(neg.log_h_ref - std::log10(0.18) + params.exposure_ev * std::log10(2.0));

  // 2) negative development: analytical dye amounts vs log H
  const auto status_m = status_response(g, Densitometry::StatusM);
  auto neg_curves = analytical_dye_curves(neg, status_m);
  const double dx = neg.log_h[1] - neg.log_h[0];
  for (int k = 0; k < 3; ++k)
    neg_dye_[k] = Curve(neg.log_h.front(), dx, std::vector<float>(neg_curves[k].begin(), neg_curves[k].end()), true);
  for (int k = 0; k < 3; ++k)
    neg_dye_max_[k] = static_cast<float>(*std::max_element(neg_curves[k].begin(), neg_curves[k].end()));
  neg_dmin_.assign(neg.dmin.begin(), neg.dmin.end());
  neg_dye_density_.resize(3 * L_);
  for (int k = 0; k < 3; ++k)
    for (int i = 0; i < L_; ++i) neg_dye_density_[k * L_ + i] = static_cast<float>(neg.dye_density[k][i]);
  report_.dmin_status = status_density(g, neg.dmin, status_m);

  // 3) printing: lamp x paper spectral sensitivity
  const Spectrum lamp = planck(g, params.printer_kelvin);
  print_weight_.resize(3 * L_);
  for (int k = 0; k < 3; ++k) {
    double sum = 0;
    for (int i = 0; i < L_; ++i) sum += lamp[i] * std::pow(10.0, paper.log_sensitivity[k][i]);
    for (int i = 0; i < L_; ++i)
      print_weight_[k * L_ + i] = static_cast<float>(lamp[i] * std::pow(10.0, paper.log_sensitivity[k][i]) / sum);
  }
  const auto status_a = status_response(g, Densitometry::StatusA);
  auto paper_curves = analytical_dye_curves(paper, status_a);
  const double pdx = paper.log_h[1] - paper.log_h[0];
  for (int k = 0; k < 3; ++k)
    paper_dye_[k] = Curve(paper.log_h.front(), pdx, std::vector<float>(paper_curves[k].begin(), paper_curves[k].end()), false);
  for (int k = 0; k < 3; ++k) {
    paper_mid_log_h_[k] = static_cast<float>(paper.log_h.back());
    for (std::size_t n = 1; n < paper.log_h.size(); ++n)
      if (paper.density[k][n] >= 0.75) {
        double f = (0.75 - paper.density[k][n - 1]) / (paper.density[k][n] - paper.density[k][n - 1]);
        paper_mid_log_h_[k] = static_cast<float>(paper.log_h[n - 1] + f * (paper.log_h[n] - paper.log_h[n - 1]));
        break;
      }
  }
  paper_dye_density_.resize(3 * L_);
  for (int k = 0; k < 3; ++k)
    for (int i = 0; i < L_; ++i) paper_dye_density_[k * L_ + i] = static_cast<float>(paper.dye_density[k][i]);

  // 4) viewing + scan: reflectance x illuminant -> XYZ, paper white adapted to D65 white
  const Spectrum view = planck(g, params.viewing_kelvin);
  double ysum = 0;
  for (int i = 0; i < L_; ++i) ysum += view[i] * cmf[1][i];
  view_weight_.resize(3 * L_);
  for (int k = 0; k < 3; ++k)
    for (int i = 0; i < L_; ++i) view_weight_[k * L_ + i] = static_cast<float>(view[i] * cmf[k][i] / ysum);
  Vec3 paper_white{};
  for (int i = 0; i < L_; ++i) {
    double d = 0;
    for (int k = 0; k < 3; ++k) d += paper_dye_[k].front() * paper.dye_density[k][i];
    double r = std::pow(10.0, -d);
    for (int k = 0; k < 3; ++k) paper_white[k] += r * view_weight_[k * L_ + i];
  }
  const double yw = paper_white[1];
  output_ = mul(xyz_to_srgb(), bradford({paper_white[0] / yw, 1.0, paper_white[2] / yw}, d65_white()));
  for (auto& row : output_)
    for (auto& v : row) v /= yw;

  // paper D-max as the scanner sees it; optionally mapped to black
  {
    Vec3 xyz{};
    for (int i = 0; i < L_; ++i) {
      double d = 0;
      for (int k = 0; k < 3; ++k) {
        // largest dye amount the paper reaches
        d += paper_curves[k].back() * paper.dye_density[k][i];
      }
      double r = std::pow(10.0, -d);
      for (int k = 0; k < 3; ++k) xyz[k] += r * view_weight_[k * L_ + i];
    }
    report_.paper_black = mul(output_, xyz);
    if (params.scan_black_point)
      for (int k = 0; k < 3; ++k) {
        black_[k] = static_cast<float>(report_.paper_black[k]);
        black_scale_[k] = 1.0f / (1.0f - black_[k]);
      }
  }

  fit_interlayer(params.dir_strength);
  balance_printer(params);
  {
    const double h = 0.02;
    Vec3 lo = process(Vec3{0.18, 0.18, 0.18}), hi = process(Vec3{0.18 * std::pow(10.0, h), 0.18 * std::pow(10.0, h), 0.18 * std::pow(10.0, h)});
    report_.system_gamma = (std::log10(hi[1]) - std::log10(lo[1])) / h;
  }
}

Mat3 FilmPipeline::grey_response(double ev) const {
  // columns: input channel aligned to layer (layer 0 = blue-sensitive <- input blue, ...)
  const float h = 0.05f, g0 = static_cast<float>(0.18 * std::pow(2.0, ev));
  std::vector<float> scratch(L_);
  float g[3] = {g0, g0, g0}, base[3];
  print_log_exposure(g, base, scratch.data());
  Mat3 J{};
  for (int c = 0; c < 3; ++c) {
    float in[3] = {g0, g0, g0}, lp[3];
    in[2 - c] *= std::pow(10.0f, h);
    print_log_exposure(in, lp, scratch.data());
    for (int k = 0; k < 3; ++k) J[k][c] = (lp[k] - base[k]) / h;
  }
  return J;
}

namespace {
// Solve the n x n system A x = b in place (partial pivoting); returns false when singular.
bool solve_dense(std::vector<double>& A, std::vector<double>& b, int n) {
  for (int col = 0; col < n; ++col) {
    int piv = col;
    for (int i = col + 1; i < n; ++i)
      if (std::abs(A[i * n + col]) > std::abs(A[piv * n + col])) piv = i;
    if (std::abs(A[piv * n + col]) < 1e-12) return false;
    for (int j = 0; j < n; ++j) std::swap(A[piv * n + j], A[col * n + j]);
    std::swap(b[piv], b[col]);
    for (int i = col + 1; i < n; ++i) {
      double f = A[i * n + col] / A[col * n + col];
      for (int j = col; j < n; ++j) A[i * n + j] -= f * A[col * n + j];
      b[i] -= f * b[col];
    }
  }
  for (int i = n - 1; i >= 0; --i) {
    double v = b[i];
    for (int j = i + 1; j < n; ++j) v -= A[i * n + j] * b[j];
    b[i] = v / A[i * n + i];
  }
  return true;
}
}  // namespace

void FilmPipeline::fit_interlayer(double strength) {
  const float offset = log_h_grey_offset_;
  log_h_grey_offset_ = static_cast<float>(offset - exposure_ev_ * std::log10(2.0));  // fit at normal exposure
  report_.crosstalk_before = grey_response();
  // M2: least squares over a grey ramp (-2..+2 EV) instead of zeroing crosstalk at grey only, so the
  // inhibition that cleans up mid-grey does not over-correct in shadows and highlights.
  constexpr int kOff[6][2] = {{0, 1}, {0, 2}, {1, 0}, {1, 2}, {2, 0}, {2, 1}};
  constexpr double kEv[5] = {-2, -1, 0, 1, 2};
  constexpr double kWeight[5] = {0.5, 1, 2, 1, 0.5};  // grey matters most
  constexpr int R = 30;
  auto residual = [&](std::array<double, R>& r) {
    for (int e = 0; e < 5; ++e) {
      Mat3 J = grey_response(kEv[e]);
      for (int i = 0; i < 6; ++i) r[e * 6 + i] = kWeight[e] * J[kOff[i][0]][kOff[i][1]];
    }
  };
  auto cost = [](const std::array<double, R>& r) { double c = 0; for (double v : r) c += v * v; return c; };
  std::array<double, R> r{};
  residual(r);
  for (int it = 0; it < 25 && strength > 0; ++it) {
    double c0 = cost(r);
    if (c0 < 1e-10) break;
    std::vector<double> Jm(R * 6);
    for (int j = 0; j < 6; ++j) {
      auto saved = dir_;
      dir_[kOff[j][0]][kOff[j][1]] += 1e-3f;
      std::array<double, R> rj{};
      residual(rj);
      dir_ = saved;
      for (int i = 0; i < R; ++i) Jm[i * 6 + j] = (rj[i] - r[i]) / 1e-3;
    }
    std::vector<double> A(36, 0.0), g(6, 0.0);
    for (int a = 0; a < 6; ++a) {
      for (int b2 = 0; b2 < 6; ++b2)
        for (int i = 0; i < R; ++i) A[a * 6 + b2] += Jm[i * 6 + a] * Jm[i * 6 + b2];
      for (int i = 0; i < R; ++i) g[a] -= Jm[i * 6 + a] * r[i];
      A[a * 6 + a] *= 1.0 + 1e-6;
    }
    if (!solve_dense(A, g, 6)) throw std::runtime_error("interlayer fit is singular");
    // damped step: halve until the cost drops
    auto saved = dir_;
    double t = 1;
    std::array<double, R> rn{};
    for (int ls = 0; ls < 8; ++ls, t *= 0.5) {
      dir_ = saved;
      for (int j = 0; j < 6; ++j) dir_[kOff[j][0]][kOff[j][1]] += static_cast<float>(std::clamp(t * g[j], -0.5, 0.5));
      residual(rn);
      if (cost(rn) < c0) break;
    }
    if (!(cost(rn) < c0)) { dir_ = saved; break; }
    double drop = c0 - cost(rn);
    r = rn;
    if (drop < 1e-9 * c0) break;
  }
  for (auto& row : dir_)
    for (auto& v : row) v = static_cast<float>(v * strength);
  double off = 0;
  for (int i = 0; i < 6; ++i) off += std::abs(dir_[kOff[i][0]][kOff[i][1]]);
  dir_self_ = static_cast<float>(off / 6);  // assumption: self-inhibition ~ mean interlayer inhibition
  for (int k = 0; k < 3; ++k)
    for (int j = 0; j < 3; ++j) report_.interlayer[k][j] = dir_[k][j];
  report_.crosstalk_after = grey_response();
  for (int e = 0; e < 5; ++e) {
    Mat3 J = grey_response(kEv[e]);
    double worst = 0;
    for (int i = 0; i < 6; ++i) worst = std::max(worst, std::abs(J[kOff[i][0]][kOff[i][1]]));
    report_.crosstalk_ramp[e] = worst;
  }
  log_h_grey_offset_ = offset;
}

void FilmPipeline::balance_printer(const RenderParams& params) {
  // Find per-layer printer light (log10 gain) so a normally exposed grey prints as neutral `print_grey`.
  const Vec3 grey{0.18, 0.18, 0.18};
  auto offset = log_h_grey_offset_;
  // balance at normal exposure, then restore the requested camera exposure
  log_h_grey_offset_ = static_cast<float>(offset - params.exposure_ev * std::log10(2.0));
  // start where the paper curves are steepest-ish: grey lands on paper density ~0.75
  {
    std::vector<float> scratch(L_);
    float in[3] = {0.18f, 0.18f, 0.18f}, logp[3];
    print_log_exposure(in, logp, scratch.data());
    for (int k = 0; k < 3; ++k) print_gain_log_[k] = paper_mid_log_h_[k] - logp[k];
  }
  const double target = std::log10(params.print_grey);
  int it = 0;
  for (; it < 40; ++it) {
    Vec3 out = process(grey);
    Vec3 r{};
    for (int k = 0; k < 3; ++k) r[k] = std::log10(std::max(out[k], 1e-9)) - target;
    if (std::max({std::abs(r[0]), std::abs(r[1]), std::abs(r[2])}) < 1e-6) break;
    Mat3 J{};
    for (int c = 0; c < 3; ++c) {
      auto saved = print_gain_log_;
      print_gain_log_[c] += 1e-3f;
      Vec3 o = process(grey);
      print_gain_log_ = saved;
      for (int k = 0; k < 3; ++k) J[k][c] = (std::log10(std::max(o[k], 1e-9)) - std::log10(std::max(out[k], 1e-9))) / 1e-3;
    }
    Vec3 step = solve3(J, r);
    for (int c = 0; c < 3; ++c) print_gain_log_[c] -= static_cast<float>(std::clamp(step[c], -1.0, 1.0));
  }
  report_.balance_iterations = it;
  report_.grey_out = process(grey);
  for (int k = 0; k < 3; ++k) report_.printer_log_gain[k] = print_gain_log_[k];
  // negative densities of the balanced grey (diagnostics)
  {
    Vec3 e = mul(exposure_, grey);
    Spectrum d(L_);
    for (int i = 0; i < L_; ++i) {
      d[i] = neg_dmin_[i];
      for (int k = 0; k < 3; ++k)
        d[i] += neg_dye_[k](static_cast<float>(std::log10(e[k])) + log_h_grey_offset_) * neg_dye_density_[k * L_ + i];
    }
    report_.grey_negative_status = status_density(grid_, d, status_response(grid_, Densitometry::StatusM));
  }
  log_h_grey_offset_ = offset;
}

void FilmPipeline::layer_exposure(const float* in, float* e) const {
  float rgb[3] = {std::max(in[0], 0.0f), std::max(in[1], 0.0f), std::max(in[2], 0.0f)};
  if (ootf_inv_exp_ != 0.0f) {
    // display-referred -> scene-referred. Below grey the log slope is 1/gamma; above it the slope eases
    // back to 1 over ~1 EV (smoothstep in log Y) so diffuse white stays near white -- SDR renderings
    // already shoulder their highlights.
    float y = 0.2126f * rgb[0] + 0.7152f * rgb[1] + 0.0722f * rgb[2];
    if (y > 1e-9f) {
      const float inv = 1.0f + ootf_inv_exp_, knee = 0.3f;
      float x = std::log10(y / 0.18f), fx;
      if (x <= 0.0f) {
        fx = x * inv;
      } else {
        float t = x / knee, ramp = t < 1.0f ? t * t * t - 0.5f * t * t * t * t : t - 0.5f;
        fx = x * inv + (1.0f - inv) * knee * ramp;
      }
      float s = std::pow(10.0f, fx - x);
      for (float& c : rgb) c *= s;
    }
  }
  for (int k = 0; k < 3; ++k) {
    float v = static_cast<float>(exposure_[k][0]) * rgb[0] + static_cast<float>(exposure_[k][1]) * rgb[1] +
              static_cast<float>(exposure_[k][2]) * rgb[2];
    e[k] = (v + flare_) * flare_norm_;
  }
}

void FilmPipeline::log_exposure(const float* e, float* lh) const {
  for (int k = 0; k < 3; ++k) lh[k] = std::log10(std::max(e[k], 1e-7f)) + log_h_grey_offset_;
}

void FilmPipeline::undeveloped(const float* lh, float* a, float* inhibit) const {
  // DIR couplers: development in one layer releases inhibitor that holds back its neighbours
  // (Hunt, Reproduction of Colour, interimage effects). The datasheet curves are measured with
  // neutral exposures, so inhibition acts only on the departure from neutral: layer j's dye
  // relative to what it would have formed at layer k's exposure. Neutral scales stay exact.
  for (int k = 0; k < 3; ++k) a[k] = neg_dye_[k](lh[k]);
  for (int k = 0; k < 3; ++k) {
    float v = 0;
    for (int j = 0; j < 3; ++j)
      if (j != k && dir_[k][j] != 0.0f) v += dir_[k][j] * (a[j] - neg_dye_[j](lh[k]));
    inhibit[k] = v;
  }
}

void FilmPipeline::develop(const float* lh, const float* inhibit, float* a) const {
  for (int k = 0; k < 3; ++k) a[k] = inhibit[k] != 0.0f ? neg_dye_[k](lh[k] - inhibit[k]) : neg_dye_[k](lh[k]);
}

void FilmPipeline::print_log_from_dye(const float* a, float* logp, float* trans) const {
  const int L = L_;
  const float* dy = neg_dye_density_.data();
  for (int i = 0; i < L; ++i)
    trans[i] = pow10_neg(neg_dmin_[i] + a[0] * dy[i] + a[1] * dy[L + i] + a[2] * dy[2 * L + i]);
  for (int k = 0; k < 3; ++k) {
    const float* w = print_weight_.data() + k * L;
    float s = 0;
    for (int i = 0; i < L; ++i) s += w[i] * trans[i];
    logp[k] = std::log10(std::max(s, 1e-12f));
  }
}

void FilmPipeline::print_log_exposure(const float* in, float* logp, float* trans) const {
  float e[3], lh[3], a[3], inhibit[3];
  layer_exposure(in, e);
  log_exposure(e, lh);
  undeveloped(lh, a, inhibit);
  develop(lh, inhibit, a);
  print_log_from_dye(a, logp, trans);
}

void FilmPipeline::finish(const float* a, float* out, float* trans) const {
  const int L = L_;
  float logp[3], p[3];
  print_log_from_dye(a, logp, trans);
  for (int k = 0; k < 3; ++k) p[k] = paper_dye_[k](logp[k] + print_gain_log_[k]);
  // print reflectance -> XYZ
  const float* pd = paper_dye_density_.data();
  for (int i = 0; i < L; ++i) trans[i] = pow10_neg(p[0] * pd[i] + p[1] * pd[L + i] + p[2] * pd[2 * L + i]);
  float xyz[3];
  for (int k = 0; k < 3; ++k) {
    const float* w = view_weight_.data() + k * L;
    float s = 0;
    for (int i = 0; i < L; ++i) s += w[i] * trans[i];
    xyz[k] = s;
  }
  for (int k = 0; k < 3; ++k) {
    float v = static_cast<float>(output_[k][0] * xyz[0] + output_[k][1] * xyz[1] + output_[k][2] * xyz[2]);
    out[k] = (v - black_[k]) * black_scale_[k];
  }
}

void FilmPipeline::process_one(const float* in, float* out, float* trans) const {
  float e[3], lh[3], a[3], inhibit[3];
  layer_exposure(in, e);
  log_exposure(e, lh);
  undeveloped(lh, a, inhibit);
  develop(lh, inhibit, a);
  finish(a, out, trans);
}

void FilmPipeline::process(const float* in, float* out, std::size_t n) const {
  std::vector<float> scratch(L_);
  for (std::size_t i = 0; i < n; ++i) process_one(in + 3 * i, out + 3 * i, scratch.data());
}

Vec3 FilmPipeline::process(const Vec3& rgb) const {
  float in[3] = {static_cast<float>(rgb[0]), static_cast<float>(rgb[1]), static_cast<float>(rgb[2])}, out[3];
  std::vector<float> scratch(L_);
  process_one(in, out, scratch.data());
  return {out[0], out[1], out[2]};
}

}  // namespace ffe

namespace ffe {
Vec3 FilmPipeline::printing_log_exposure(const Vec3& rgb) const {
  float in[3] = {static_cast<float>(rgb[0]), static_cast<float>(rgb[1]), static_cast<float>(rgb[2])}, logp[3];
  std::vector<float> scratch(L_);
  print_log_exposure(in, logp, scratch.data());
  return {logp[0], logp[1], logp[2]};
}
}  // namespace ffe
