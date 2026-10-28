#include <cstring>

#include "check.hpp"
#include "engine.hpp"

using namespace ffe;

namespace {
Engine& engine() {
  static Engine e(std::make_shared<const StockLibrary>(FFE_DATA_DIR), 2);
  return e;
}
Frame call(JsonObject header, std::vector<std::uint8_t> payload = {}) {
  return engine().handle(Frame{Json(std::move(header)), std::move(payload)});
}
std::string error_code(const Frame& f) {
  return f.header["ok"].as_bool() ? "" : f.header["error"]["code"].as_string();
}
}  // namespace

TEST(hello_reports_version) {
  Frame f = call({{"op", "hello"}, {"id", 7}});
  CHECK(f.header["ok"].as_bool());
  CHECK_NEAR(f.header["id"].as_number(), 7, 0);
  CHECK(f.header["version"].as_string() == kEngineVersion);
  CHECK_NEAR(f.header["protocol"].as_number(), kProtocolVersion, 0);
}

TEST(lists_stocks) {
  Frame f = call({{"op", "list_stocks"}});
  bool neg = false, paper = false;
  for (const auto& s : f.header["stocks"].as_array()) {
    neg |= s["id"].as_string() == "portrait400" && s["kind"].as_string() == "negative";
    paper |= s["id"].as_string() == "premierpaper" && s["kind"].as_string() == "paper";
  }
  CHECK(neg && paper);
}

TEST(errors_are_structured) {
  CHECK(error_code(call({{"op", "fly"}})) == "unknown_op");
  CHECK(error_code(call({{"op", "bake_lut"}, {"stock", "nope"}})) == "unknown_stock");
  CHECK(error_code(call({{"op", "bake_lut"}, {"stock", "premierpaper"}})) == "unknown_stock");
  CHECK(error_code(call({{"op", "bake_lut"}, {"stock", "portrait400"}, {"size", 1}})) == "bad_request");
  CHECK(error_code(call({{"op", "bake_lut"}, {"stock", "portrait400"}, {"params", Json(JsonObject{{"exposureEv", 9}})}})) ==
        "bad_request");
  CHECK(error_code(call({{"op", "bake_lut"}, {"stock", "portrait400"}, {"params", Json(JsonObject{{"scanBlackPoint", 1}})}})) ==
        "bad_request");
  CHECK(error_code(call({{"op", "render"}, {"stock", "portrait400"}, {"width", 2}, {"height", 1}}, {1, 2, 3})) ==
        "bad_request");
}

TEST(bakes_lut_with_neutral_axis) {
  const std::size_t n = 9;
  Frame f = call({{"op", "bake_lut"}, {"stock", "portrait400"}, {"size", n}});
  CHECK(f.header["ok"].as_bool());
  CHECK(f.payload.size() == n * n * n * 3 * sizeof(float));
  std::vector<float> lut(n * n * n * 3);
  std::memcpy(lut.data(), f.payload.data(), f.payload.size());
  for (float v : lut) CHECK(v >= 0 && v <= 1);
  for (std::size_t i = 0; i < n; ++i) {
    const float* px = &lut[3 * (i + n * (i + n * i))];
    float m = (px[0] + px[1] + px[2]) / 3;
    for (int k = 0; k < 3; ++k) CHECK(std::abs(px[k] - m) < 0.03);
  }
  // red varies fastest: entry 1 is (r=1/(n-1), 0, 0)
  const float* pure_red = &lut[3 * (n - 1)];
  CHECK(pure_red[0] > pure_red[1] && pure_red[0] > pure_red[2]);
}

TEST(spatial_render_params) {
  std::vector<std::uint8_t> px(3 * 8 * 8, 120);
  CHECK(error_code(call({{"op", "render"}, {"stock", "portrait400"}, {"width", 8}, {"height", 8},
                         {"params", Json(JsonObject{{"dirDiffusionUm", 500}})}}, px)) == "bad_request");
  Frame flat = call({{"op", "render"}, {"stock", "portrait400"}, {"width", 8}, {"height", 8}}, px);
  Frame dir = call({{"op", "render"}, {"stock", "portrait400"}, {"width", 8}, {"height", 8},
                    {"params", Json(JsonObject{{"dirDiffusionUm", 20}, {"filmFormatMm", 8}})}}, px);
  CHECK(dir.header["ok"].as_bool());
  CHECK(dir.payload == flat.payload);  // uniform frame: diffusion changes nothing
}

TEST(renders_rgb8_and_rgb16) {
  std::vector<std::uint8_t> px8 = {118, 118, 118, 255, 0, 0, 0, 0, 0};
  Frame a = call({{"op", "render"}, {"stock", "portrait400"}, {"width", 3}, {"height", 1}, {"format", "rgb8"}}, px8);
  CHECK(a.header["ok"].as_bool());
  CHECK(a.payload.size() == px8.size());
  CHECK(std::abs(int(a.payload[0]) - int(a.payload[1])) <= 3);  // 18% grey stays neutral
  CHECK(std::abs(int(a.payload[0]) - 118) <= 3);
  CHECK(a.payload[3] > a.payload[4]);
  CHECK(a.payload[6] < 8);
  std::vector<std::uint8_t> px16;
  for (std::uint8_t v : px8) { px16.push_back(v); px16.push_back(v); }  // v * 257
  Frame b = call({{"op", "render"}, {"stock", "portrait400"}, {"width", 3}, {"height", 1}, {"format", "rgb16"}}, px16);
  CHECK(b.header["ok"].as_bool());
  CHECK(b.payload.size() == px16.size());
  for (std::size_t i = 0; i < px8.size(); ++i) CHECK(std::abs(int(b.payload[2 * i + 1]) - int(a.payload[i])) <= 1);
}

TEST(shutdown_sets_flag) {
  Engine e(std::make_shared<const StockLibrary>(FFE_DATA_DIR), 1);
  e.handle(Frame{Json(JsonObject{{"op", "shutdown"}}), {}});
  CHECK(e.shutdown_requested());
}

TEST_MAIN
