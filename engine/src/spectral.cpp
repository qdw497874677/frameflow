#include "spectral.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace ffe {

Vec3 mul(const Mat3& m, const Vec3& v) {
  return {m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
          m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
          m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]};
}

Mat3 mul(const Mat3& a, const Mat3& b) {
  Mat3 r{};
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j)
      for (int k = 0; k < 3; ++k) r[i][j] += a[i][k] * b[k][j];
  return r;
}

Mat3 inverse(const Mat3& m) {
  double a = m[0][0], b = m[0][1], c = m[0][2], d = m[1][0], e = m[1][1], f = m[1][2], g = m[2][0],
         h = m[2][1], i = m[2][2];
  double A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  double det = a * A + b * B + c * C;
  if (!(std::abs(det) > 1e-300)) throw std::runtime_error("singular matrix");
  double s = 1.0 / det;
  return {{{A * s, -(b * i - c * h) * s, (b * f - c * e) * s},
           {B * s, (a * i - c * g) * s, -(a * f - c * d) * s},
           {C * s, -(a * h - b * g) * s, (a * e - b * d) * s}}};
}

Mat3 diag(const Vec3& v) { return {{{v[0], 0, 0}, {0, v[1], 0}, {0, 0, v[2]}}}; }

namespace {
double lobe(double x, double mu, double s1, double s2) {
  double t = (x - mu) / (x < mu ? s1 : s2);
  return std::exp(-0.5 * t * t);
}
}  // namespace

std::array<Spectrum, 3> cie1931_cmf(const Grid& g) {
  std::array<Spectrum, 3> c;
  for (auto& s : c) s.resize(g.count);
  for (int i = 0; i < g.count; ++i) {
    double l = g.at(i);
    c[0][i] = 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) -
              0.065 * lobe(l, 501.1, 20.4, 26.2);
    c[1][i] = 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
    c[2][i] = 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
  }
  return c;
}

Spectrum planck(const Grid& g, double kelvin) {
  constexpr double c2 = 1.4387769e-2;  // second radiation constant, m*K
  auto radiance = [&](double nm) {
    double l = nm * 1e-9;
    return 1.0 / (std::pow(l, 5) * (std::exp(c2 / (l * kelvin)) - 1.0));
  };
  double ref = radiance(560.0);
  Spectrum s(g.count);
  for (int i = 0; i < g.count; ++i) s[i] = radiance(g.at(i)) / ref;
  return s;
}

Vec3 white_xyz(const Grid& g, const Spectrum& ill, const std::array<Spectrum, 3>& cmf) {
  Vec3 w{};
  for (int i = 0; i < g.count; ++i)
    for (int k = 0; k < 3; ++k) w[k] += ill[i] * cmf[k][i];
  double y = w[1];
  return {w[0] / y, 1.0, w[2] / y};
}

Vec3 d65_white() { return {0.3127 / 0.3290, 1.0, (1.0 - 0.3127 - 0.3290) / 0.3290}; }

Mat3 srgb_to_xyz() {
  // Primaries x,y (IEC 61966-2-1) and D65 white; matrix derived, not tabulated.
  const double xy[3][2] = {{0.64, 0.33}, {0.30, 0.60}, {0.15, 0.06}};
  Mat3 p{};
  for (int j = 0; j < 3; ++j) {
    double x = xy[j][0], y = xy[j][1];
    p[0][j] = x / y;
    p[1][j] = 1.0;
    p[2][j] = (1 - x - y) / y;
  }
  Vec3 s = mul(inverse(p), d65_white());
  return mul(p, diag(s));
}

Mat3 xyz_to_srgb() { return inverse(srgb_to_xyz()); }

double srgb_decode(double v) { return v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4); }
double srgb_encode(double v) {
  v = std::clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * std::pow(v, 1.0 / 2.4) - 0.055;
}

Mat3 bradford(const Vec3& from, const Vec3& to) {
  const Mat3 m{{{0.8951, 0.2664, -0.1614}, {-0.7502, 1.7135, 0.0367}, {0.0389, -0.0685, 1.0296}}};
  Vec3 a = mul(m, from), b = mul(m, to);
  return mul(inverse(m), mul(diag({b[0] / a[0], b[1] / a[1], b[2] / a[2]}), m));
}

namespace {

// Dense symmetric positive definite solve via Cholesky (n ~ 250).
class Cholesky {
 public:
  explicit Cholesky(std::vector<double> a, int n) : n_(n), l_(std::move(a)) {
    for (int j = 0; j < n; ++j) {
      double d = l_[j * n + j];
      for (int k = 0; k < j; ++k) d -= l_[j * n + k] * l_[j * n + k];
      if (d <= 0) throw std::runtime_error("cholesky: matrix not positive definite");
      d = std::sqrt(d);
      l_[j * n + j] = d;
      for (int i = j + 1; i < n; ++i) {
        double s = l_[i * n + j];
        for (int k = 0; k < j; ++k) s -= l_[i * n + k] * l_[j * n + k];
        l_[i * n + j] = s / d;
      }
    }
  }
  std::vector<double> solve(std::vector<double> b) const {
    for (int i = 0; i < n_; ++i) {
      for (int k = 0; k < i; ++k) b[i] -= l_[i * n_ + k] * b[k];
      b[i] /= l_[i * n_ + i];
    }
    for (int i = n_ - 1; i >= 0; --i) {
      for (int k = i + 1; k < n_; ++k) b[i] -= l_[k * n_ + i] * b[k];
      b[i] /= l_[i * n_ + i];
    }
    return b;
  }

 private:
  int n_;
  std::vector<double> l_;
};

}  // namespace

UpsamplingBasis solve_upsampling_basis(const Grid& g, const Spectrum& ill,
                                       const std::array<Spectrum, 3>& cmf) {
  const int L = g.count, n = 3 * L;
  // Rows of the constraint matrix C (dense, m x n):
  //   9 colour rows: for basis j and XYZ component k, sum_l b_j(l) ill(l) cmf_k(l) / norm = target
  //   L partition rows: sum_j b_j(l) = 1
  //   n box rows: 0 <= x <= 1 (identity)
  double norm = 0;
  for (int l = 0; l < L; ++l) norm += ill[l] * cmf[1][l];
  Vec3 w = white_xyz(g, ill, cmf);
  Mat3 prim = mul(bradford(d65_white(), w), srgb_to_xyz());  // columns = target XYZ of primaries

  const int m_eq = 9 + L, m = m_eq + n;
  std::vector<double> C(static_cast<std::size_t>(m_eq) * n, 0.0);
  std::vector<double> lo(m), hi(m);
  for (int j = 0; j < 3; ++j)
    for (int k = 0; k < 3; ++k) {
      int r = j * 3 + k;
      for (int l = 0; l < L; ++l) C[r * n + j * L + l] = ill[l] * cmf[k][l] / norm;
      lo[r] = hi[r] = prim[k][j];
    }
  for (int l = 0; l < L; ++l) {
    int r = 9 + l;
    for (int j = 0; j < 3; ++j) C[r * n + j * L + l] = 1.0;
    lo[r] = hi[r] = 1.0;
  }
  for (int i = 0; i < n; ++i) { lo[m_eq + i] = 0.0; hi[m_eq + i] = 1.0; }

  // Objective 0.5 x'Px with P = D'D (first differences within each basis spectrum).
  std::vector<double> P(static_cast<std::size_t>(n) * n, 0.0);
  for (int j = 0; j < 3; ++j)
    for (int l = 0; l + 1 < L; ++l) {
      int a = j * L + l, b = a + 1;
      P[a * n + a] += 1; P[b * n + b] += 1; P[a * n + b] -= 1; P[b * n + a] -= 1;
    }

  // ADMM (OSQP-style splitting) with a larger penalty on equality rows.
  const double sigma = 1e-6, alpha = 1.6, rho_box = 0.1, rho_eq = 1e3 * rho_box;
  std::vector<double> rho(m);
  for (int r = 0; r < m; ++r) rho[r] = r < m_eq ? rho_eq : rho_box;
  std::vector<double> K = P;
  for (int i = 0; i < n; ++i) K[i * n + i] += sigma + rho_box;
  for (int r = 0; r < m_eq; ++r)
    for (int a = 0; a < n; ++a) {
      double ca = C[r * n + a];
      if (ca == 0) continue;
      for (int b = 0; b < n; ++b) K[a * n + b] += rho[r] * ca * C[r * n + b];
    }
  Cholesky chol(K, n);

  auto apply_C = [&](const std::vector<double>& x) {
    std::vector<double> z(m, 0.0);
    for (int r = 0; r < m_eq; ++r) {
      double s = 0;
      for (int a = 0; a < n; ++a) s += C[r * n + a] * x[a];
      z[r] = s;
    }
    for (int i = 0; i < n; ++i) z[m_eq + i] = x[i];
    return z;
  };

  std::vector<double> x(n, 1.0 / 3.0), z = apply_C(x), y(m, 0.0);
  for (int it = 0; it < 4000; ++it) {
    std::vector<double> rhs(n);
    for (int a = 0; a < n; ++a) rhs[a] = sigma * x[a];
    for (int r = 0; r < m_eq; ++r) {
      double t = rho[r] * z[r] - y[r];
      for (int a = 0; a < n; ++a) rhs[a] += C[r * n + a] * t;
    }
    for (int i = 0; i < n; ++i) rhs[i] += rho_box * z[m_eq + i] - y[m_eq + i];
    std::vector<double> xt = chol.solve(rhs);
    std::vector<double> zt = apply_C(xt);
    double prim_res = 0;
    for (int a = 0; a < n; ++a) x[a] = alpha * xt[a] + (1 - alpha) * x[a];
    for (int r = 0; r < m; ++r) {
      double zr = alpha * zt[r] + (1 - alpha) * z[r];
      double zn = std::clamp(zr + y[r] / rho[r], lo[r], hi[r]);
      y[r] += rho[r] * (zr - zn);
      z[r] = zn;
    }
    if (it % 50 == 49) {
      std::vector<double> cx = apply_C(x);
      prim_res = 0;
      for (int r = 0; r < m; ++r)
        prim_res = std::max(prim_res, std::max(lo[r] - cx[r], cx[r] - hi[r]));
      if (prim_res < 1e-7) break;
    }
  }

  UpsamplingBasis out;
  for (int j = 0; j < 3; ++j) {
    out.basis[j].resize(L);
    for (int l = 0; l < L; ++l) out.basis[j][l] = std::clamp(x[j * L + l], 0.0, 1.0);
  }
  // Renormalise the partition of unity exactly and measure the primaries' error.
  for (int l = 0; l < L; ++l) {
    double s = out.basis[0][l] + out.basis[1][l] + out.basis[2][l];
    for (int j = 0; j < 3; ++j) out.basis[j][l] /= s;
  }
  for (int j = 0; j < 3; ++j)
    for (int k = 0; k < 3; ++k) {
      double v = 0;
      for (int l = 0; l < L; ++l) v += out.basis[j][l] * ill[l] * cmf[k][l] / norm;
      out.max_error = std::max(out.max_error, std::abs(v - prim[k][j]));
    }
  return out;
}

}  // namespace ffe
