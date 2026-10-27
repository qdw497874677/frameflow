// Film / paper stock data as published by the manufacturer (digitized), see engine/PROVENANCE.md.
#pragma once
#include <array>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "json.hpp"
#include "spectral.hpp"

namespace ffe {

enum class StockKind { Negative, Paper };
enum class Densitometry { StatusM, StatusA };

// Layer order everywhere: 0 = blue-sensitive / yellow dye, 1 = green / magenta, 2 = red / cyan.
struct Stock {
  std::string id, name, inspired_by;
  StockKind kind = StockKind::Negative;
  Grid grid;
  std::array<Spectrum, 3> log_sensitivity;
  std::array<Spectrum, 3> dye_density;  // peak-normalised spectral density per dye
  Spectrum dmin;                        // base + fog spectral density (zero when folded into curves)
  Densitometry densitometry = Densitometry::StatusM;
  std::vector<double> log_h;            // uniform grid
  std::array<std::vector<double>, 3> density;  // integral density per channel (B, G, R) vs log_h
  double log_h_ref = 0.0;               // log H of a normally exposed 18% grey (negatives)
};

Stock parse_stock(const Json& j);
Stock load_stock_file(const std::string& path);

class StockLibrary {
 public:
  explicit StockLibrary(std::string dir);
  const std::vector<std::shared_ptr<const Stock>>& all() const { return stocks_; }
  std::shared_ptr<const Stock> find(const std::string& id) const;

 private:
  std::vector<std::shared_ptr<const Stock>> stocks_;
};

// Spectral responsivity of Status M (transmission, negatives) and Status A
// (reflection, prints) densitometry, approximated by two-sided Gaussians whose
// peak and fall-off follow ANSI/ISO 5-3-1995. Order B, G, R.
std::array<Spectrum, 3> status_response(const Grid& g, Densitometry d);

}  // namespace ffe
