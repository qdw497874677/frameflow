#include "stock.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace ffe {
namespace {

Spectrum spectrum(const Json& j, const Grid& g, const char* what) {
  Spectrum s = j.numbers();
  if (static_cast<int>(s.size()) != g.count) throw std::runtime_error(std::string("stock: bad length for ") + what);
  return s;
}

}  // namespace

Stock parse_stock(const Json& j) {
  Stock s;
  s.id = j["id"].as_string();
  s.name = j["name"].as_string();
  s.inspired_by = j.string_or("inspiredBy", "");
  const std::string kind = j["kind"].as_string();
  if (kind == "negative") s.kind = StockKind::Negative;
  else if (kind == "paper") s.kind = StockKind::Paper;
  else throw std::runtime_error("stock: unknown kind " + kind);
  const Json& wl = j["wavelengths"];
  s.grid = Grid{wl["start"].as_number(), wl["step"].as_number(), static_cast<int>(wl["count"].as_number())};
  const char* layers[3] = {"b", "g", "r"};
  const char* dyes[3] = {"y", "m", "c"};
  for (int k = 0; k < 3; ++k) {
    s.log_sensitivity[k] = spectrum(j["logSensitivity"][layers[k]], s.grid, "logSensitivity");
    s.dye_density[k] = spectrum(j["dyeDensity"][dyes[k]], s.grid, "dyeDensity");
  }
  s.dmin = spectrum(j["dmin"], s.grid, "dmin");
  const std::string dens = j["densitometry"].as_string();
  s.densitometry = dens == "status-a" ? Densitometry::StatusA : Densitometry::StatusM;
  const Json& dc = j["densityCurves"];
  s.log_h = dc["logH"].numbers();
  if (s.log_h.size() < 4) throw std::runtime_error("stock: density curve too short");
  for (int k = 0; k < 3; ++k) {
    s.density[k] = dc[layers[k]].numbers();
    if (s.density[k].size() != s.log_h.size()) throw std::runtime_error("stock: density curve length mismatch");
  }
  s.log_h_ref = j.number_or("logHRef", 0.0);
  return s;
}

Stock load_stock_file(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error("stock: cannot open " + path);
  std::stringstream ss;
  ss << f.rdbuf();
  return parse_stock(Json::parse(ss.str()));
}

StockLibrary::StockLibrary(std::string dir) {
  std::vector<std::string> files;
  for (const auto& e : std::filesystem::directory_iterator(dir))
    if (e.is_regular_file() && e.path().extension() == ".json") files.push_back(e.path().string());
  std::sort(files.begin(), files.end());
  for (const auto& p : files) stocks_.push_back(std::make_shared<const Stock>(load_stock_file(p)));
}

std::shared_ptr<const Stock> StockLibrary::find(const std::string& id) const {
  for (const auto& s : stocks_)
    if (s->id == id) return s;
  return nullptr;
}

std::array<Spectrum, 3> status_response(const Grid& g, Densitometry d) {
  struct Band { double mu, left, right; };
  // Two-sided Gaussian (linear domain) parameters, fitted by hand to the
  // decade fall-off points of the ISO 5-3 log spectral products.
  const Band m[3] = {{450, 10.9, 15.8}, {540, 16.6, 16.5}, {640, 5.5, 20.0}};
  const Band a[3] = {{440, 7.9, 12.6}, {530, 7.6, 15.1}, {620, 6.0, 25.0}};
  const Band* b = d == Densitometry::StatusM ? m : a;
  std::array<Spectrum, 3> out;
  for (int k = 0; k < 3; ++k) {
    out[k].resize(g.count);
    for (int i = 0; i < g.count; ++i) {
      double l = g.at(i), t = (l - b[k].mu) / (l < b[k].mu ? b[k].left : b[k].right);
      out[k][i] = std::exp(-0.5 * t * t);
    }
  }
  return out;
}

}  // namespace ffe
