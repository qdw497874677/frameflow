// Minimal test harness: CHECK records failures, main returns non-zero if any.
#pragma once
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace check {
inline int failures = 0;
inline std::vector<std::pair<std::string, std::function<void()>>>& registry() {
  static std::vector<std::pair<std::string, std::function<void()>>> r;
  return r;
}
struct Register {
  Register(const char* name, std::function<void()> fn) { registry().emplace_back(name, std::move(fn)); }
};
inline int run_all() {
  for (auto& [name, fn] : registry()) {
    int before = failures;
    try {
      fn();
    } catch (const std::exception& e) {
      std::printf("  exception: %s\n", e.what());
      ++failures;
    }
    std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", name.c_str());
  }
  return failures ? 1 : 0;
}
}  // namespace check

#define TEST(name) \
  static void name(); \
  static check::Register reg_##name(#name, name); \
  static void name()
#define CHECK(cond) \
  do { if (!(cond)) { std::printf("  %s:%d: CHECK(%s)\n", __FILE__, __LINE__, #cond); ++check::failures; } } while (0)
#define CHECK_NEAR(a, b, tol) \
  do { double a_ = (a), b_ = (b); if (!(std::abs(a_ - b_) <= (tol))) { \
    std::printf("  %s:%d: |%s - %s| = |%g - %g| > %g\n", __FILE__, __LINE__, #a, #b, a_, b_, (double)(tol)); ++check::failures; } } while (0)
#define CHECK_THROWS(expr) \
  do { bool t_ = false; try { (void)(expr); } catch (...) { t_ = true; } if (!t_) { \
    std::printf("  %s:%d: expected throw: %s\n", __FILE__, __LINE__, #expr); ++check::failures; } } while (0)
#define TEST_MAIN int main() { return check::run_all(); }
