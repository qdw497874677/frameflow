#include <cmath>

#include "check.hpp"
#include "stock.hpp"

using namespace ffe;

namespace {
const StockLibrary& library() {
  static StockLibrary lib(FFE_DATA_DIR);
  return lib;
}
}  // namespace

TEST(library_loads_generated_stocks) {
  CHECK(library().find("portrait400") != nullptr);
  CHECK(library().find("premierpaper") != nullptr);
  CHECK(library().find("nope") == nullptr);
  CHECK(library().find("portrait400")->kind == StockKind::Negative);
  CHECK(library().find("premierpaper")->kind == StockKind::Paper);
}

TEST(curves_are_monotone_and_finite) {
  for (const auto& s : library().all()) {
    CHECK(s->log_h.size() > 20);
    for (int k = 0; k < 3; ++k) {
      const auto& d = s->density[k];
      CHECK(d.size() == s->log_h.size());
      // Digitized curves wiggle by a few 0.001 D near the paper shoulder; allow that, require a real rise.
      for (size_t i = 1; i < d.size(); ++i) CHECK(d[i] >= d[i - 1] - 0.01);
      CHECK(d.back() - d.front() > 1.0);
      for (double v : s->log_sensitivity[k]) CHECK(std::isfinite(v));
    }
  }
}

TEST(dye_peaks_in_expected_order) {
  for (const auto& s : library().all()) {
    double peak[3];
    for (int k = 0; k < 3; ++k) {
      size_t best = 0;
      for (size_t i = 0; i < s->dye_density[k].size(); ++i)
        if (s->dye_density[k][i] > s->dye_density[k][best]) best = i;
      peak[k] = s->grid.at(static_cast<int>(best));
    }
    CHECK(peak[0] < peak[1]);
    CHECK(peak[1] < peak[2]);
  }
}

TEST(status_response_peaks) {
  Grid g;
  auto m = status_response(g, Densitometry::StatusM);
  size_t best = 0;
  for (size_t i = 0; i < m[1].size(); ++i)
    if (m[1][i] > m[1][best]) best = i;
  CHECK_NEAR(g.at(static_cast<int>(best)), 540.0, 5.0);
}

TEST_MAIN
