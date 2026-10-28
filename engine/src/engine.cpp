#include "engine.hpp"

#include "spatial.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <vector>

namespace ffe {
namespace {

class RequestError : public std::runtime_error {
 public:
  RequestError(std::string code, const std::string& msg) : std::runtime_error(msg), code_(std::move(code)) {}
  const std::string& code() const { return code_; }

 private:
  std::string code_;
};

Json request_id(const Json& req) { return req.has("id") ? req["id"] : Json(nullptr); }

Frame ok(const Json& req, JsonObject body, std::vector<std::uint8_t> payload = {}) {
  body["ok"] = true;
  body["id"] = request_id(req);
  return Frame{Json(std::move(body)), std::move(payload)};
}

Frame error(const Json& req, const std::string& code, const std::string& message) {
  JsonObject err{{"code", code}, {"message", message}};
  return Frame{Json(JsonObject{{"ok", false}, {"id", request_id(req)}, {"error", Json(std::move(err))}}), {}};
}

double param(const Json& params, const char* key, double fallback, double lo, double hi) {
  double v = params.number_or(key, fallback);
  if (!(v >= lo && v <= hi)) throw RequestError("bad_request", std::string("param out of range: ") + key);
  return v;
}

RenderParams parse_params(const Json& p) {
  RenderParams r;
  r.exposure_ev = param(p, "exposureEv", r.exposure_ev, -6, 6);
  r.scene_kelvin = param(p, "sceneKelvin", r.scene_kelvin, 2000, 12000);
  r.printer_kelvin = param(p, "printerKelvin", r.printer_kelvin, 2000, 12000);
  r.viewing_kelvin = param(p, "viewingKelvin", r.viewing_kelvin, 2000, 12000);
  r.print_grey = param(p, "printGrey", r.print_grey, 0.05, 0.5);
  r.dir_strength = param(p, "dirStrength", r.dir_strength, 0, 2);
  r.input_gamma = param(p, "inputGamma", r.input_gamma, 1, 2);
  r.camera_flare = param(p, "cameraFlare", r.camera_flare, 0, 0.1);
  const Json& black = p["scanBlackPoint"];
  if (!black.is_null()) {
    if (!black.is_bool()) throw RequestError("bad_request", "scanBlackPoint must be a boolean");
    r.scan_black_point = black.as_bool();
  }
  return r;
}

SpatialParams parse_spatial(const Json& p) {
  SpatialParams s;
  s.film_format_mm = param(p, "filmFormatMm", s.film_format_mm, 0.5, 300);  // 0.5: crop previews scale the format down to keep the pixel pitch
  s.dir_diffusion_um = param(p, "dirDiffusionUm", s.dir_diffusion_um, 0, 100);
  s.grain = param(p, "grain", s.grain, 0, 4);
  s.halation = param(p, "halation", s.halation, 0, 1);
  s.halation_radius_mm = param(p, "halationRadiusMm", s.halation_radius_mm, 0.02, 2);
  s.grain_seed = static_cast<std::uint32_t>(param(p, "grainSeed", 0, 0, 4294967295.0));
  return s;
}

std::vector<float> decode_table(int levels) {
  std::vector<float> t(levels);
  for (int i = 0; i < levels; ++i) t[i] = static_cast<float>(srgb_decode(static_cast<double>(i) / (levels - 1)));
  return t;
}

}  // namespace

Engine::Engine(std::shared_ptr<const StockLibrary> stocks, unsigned threads)
    : stocks_(std::move(stocks)), threads_(threads ? threads : std::max(1u, std::thread::hardware_concurrency())) {}

Frame Engine::handle(const Frame& request) {
  const Json& req = request.header;
  try {
    const std::string op = req.string_or("op", "");
    if (op == "hello") return hello(req);
    if (op == "list_stocks") return list_stocks(req);
    if (op == "bake_lut") return bake_lut(req);
    if (op == "render") return render(request);
    if (op == "shutdown") { shutdown_ = true; return ok(req, {}); }
    return error(req, "unknown_op", "unknown op: " + op);
  } catch (const RequestError& e) {
    return error(req, e.code(), e.what());
  } catch (const JsonError& e) {
    return error(req, "bad_request", e.what());
  } catch (const std::exception& e) {
    return error(req, "internal", e.what());
  }
}

Frame Engine::hello(const Json& req) const {
  return ok(req, {{"engine", "frameflow-film"}, {"version", kEngineVersion}, {"protocol", kProtocolVersion},
                  {"threads", static_cast<std::size_t>(threads_)}});
}

Frame Engine::list_stocks(const Json& req) const {
  JsonArray items;
  for (const auto& s : stocks_->all())
    items.push_back(Json(JsonObject{{"id", s->id}, {"name", s->name}, {"inspiredBy", s->inspired_by},
                                    {"kind", s->kind == StockKind::Negative ? "negative" : "paper"}}));
  return ok(req, {{"stocks", Json(std::move(items))}});
}

std::shared_ptr<const FilmPipeline> Engine::pipeline(const Json& req) {
  const std::string neg_id = req.string_or("stock", "");
  const std::string paper_id = req.string_or("paper", "premierpaper");
  auto neg = stocks_->find(neg_id);
  auto paper = stocks_->find(paper_id);
  if (!neg || neg->kind != StockKind::Negative) throw RequestError("unknown_stock", "unknown negative stock: " + neg_id);
  if (!paper || paper->kind != StockKind::Paper) throw RequestError("unknown_stock", "unknown paper: " + paper_id);
  RenderParams p = parse_params(req["params"]);
  char key[256];
  std::snprintf(key, sizeof key, "%s|%s|%.4f|%.1f|%.1f|%.1f|%.4f|%.3f|%d|%.4f|%.4f", neg_id.c_str(),
                paper_id.c_str(), p.exposure_ev, p.scene_kelvin, p.printer_kelvin, p.viewing_kelvin, p.print_grey,
                p.dir_strength, p.scan_black_point ? 1 : 0, p.input_gamma, p.camera_flare);
  std::lock_guard<std::mutex> lock(mu_);
  auto it = pipelines_.find(key);
  if (it != pipelines_.end()) return it->second;
  auto built = std::make_shared<const FilmPipeline>(*neg, *paper, p);
  if (pipelines_.size() > 32) pipelines_.clear();
  pipelines_[key] = built;
  return built;
}

Frame Engine::bake_lut(const Json& req) {
  auto t0 = std::chrono::steady_clock::now();
  const double size_d = req.number_or("size", 33);
  if (!(size_d >= 2 && size_d <= 129) || size_d != std::floor(size_d)) throw RequestError("bad_request", "size must be 2..129");
  const std::size_t n = static_cast<std::size_t>(size_d), count = n * n * n;
  auto pipe = pipeline(req);
  std::vector<float> rgb(count * 3);
  // .cube order: red varies fastest, then green, then blue
  for (std::size_t b = 0; b < n; ++b)
    for (std::size_t g = 0; g < n; ++g)
      for (std::size_t r = 0; r < n; ++r) {
        float* px = &rgb[3 * (r + n * (g + n * b))];
        px[0] = static_cast<float>(srgb_decode(static_cast<double>(r) / (n - 1)));
        px[1] = static_cast<float>(srgb_decode(static_cast<double>(g) / (n - 1)));
        px[2] = static_cast<float>(srgb_decode(static_cast<double>(b) / (n - 1)));
      }
  std::vector<float> out(count * 3);
  run_parallel(count, threads_, [&](std::size_t a, std::size_t e) { pipe->process(&rgb[3 * a], &out[3 * a], e - a); });
  for (auto& v : out) v = static_cast<float>(srgb_encode(v));
  std::vector<std::uint8_t> payload(out.size() * sizeof(float));
  std::memcpy(payload.data(), out.data(), payload.size());  // little-endian hosts only (checked in main)
  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return ok(req, {{"size", n}, {"format", "f32"}, {"ms", ms}}, std::move(payload));
}

Frame Engine::render(const Frame& request) {
  const Json& req = request.header;
  auto t0 = std::chrono::steady_clock::now();
  const double w = req.number_or("width", 0), h = req.number_or("height", 0);
  const std::string format = req.string_or("format", "rgb8");
  if (!(w >= 1 && h >= 1 && w * h <= 200e6)) throw RequestError("bad_request", "bad image size");
  const std::size_t px = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  const bool wide = format == "rgb16";
  if (!wide && format != "rgb8") throw RequestError("bad_request", "format must be rgb8 or rgb16");
  if (request.payload.size() != px * 3 * (wide ? 2 : 1)) throw RequestError("bad_request", "payload size mismatch");
  auto pipe = pipeline(req);
  const SpatialParams spatial = parse_spatial(req["params"]);

  static const std::vector<float> lut8 = decode_table(256);
  static const std::vector<float> lut16 = decode_table(65536);
  std::vector<std::uint8_t> payload(request.payload.size());
  const std::uint8_t* src = request.payload.data();
  std::uint8_t* dst = payload.data();
  auto encode = [&](const float* v, std::size_t c0, std::size_t count) {
    for (std::size_t i = 0; i < count; ++i) {
      std::size_t c = c0 + i;
      double e = srgb_encode(v[i]);
      if (wide) {
        auto q = static_cast<std::uint16_t>(std::lround(std::clamp(e, 0.0, 1.0) * 65535.0));
        dst[2 * c] = static_cast<std::uint8_t>(q & 0xFF);
        dst[2 * c + 1] = static_cast<std::uint8_t>(q >> 8);
      } else {
        dst[c] = static_cast<std::uint8_t>(std::lround(std::clamp(e, 0.0, 1.0) * 255.0));
      }
    }
  };
  auto decode = [&](float* v, std::size_t c0, std::size_t count) {
    for (std::size_t i = 0; i < count; ++i) {
      std::size_t c = c0 + i;
      v[i] = wide ? lut16[src[2 * c] | (src[2 * c + 1] << 8)] : lut8[src[c]];
    }
  };
  if (spatial_active(spatial)) {
    // whole-frame path (neighbourhood effects): ~50 bytes per pixel of working memory
    std::vector<float> in(px * 3), out(px * 3);
    run_parallel(px * 3, threads_, [&](std::size_t a, std::size_t e) { decode(&in[a], a, e - a); });
    render_spatial(*pipe, in.data(), out.data(), static_cast<int>(w), static_cast<int>(h), spatial, threads_);
    run_parallel(px * 3, threads_, [&](std::size_t a, std::size_t e) { encode(&out[a], a, e - a); });
  } else {
    run_parallel(px, threads_, [&](std::size_t a, std::size_t e) {
      constexpr std::size_t kBlock = 1024;
      std::vector<float> in(kBlock * 3), out(kBlock * 3);
      for (std::size_t s = a; s < e; s += kBlock) {
        std::size_t m = std::min(kBlock, e - s);
        decode(in.data(), s * 3, m * 3);
        pipe->process(in.data(), out.data(), m);
        encode(out.data(), s * 3, m * 3);
      }
    });
  }
  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return ok(req, {{"width", static_cast<std::size_t>(w)}, {"height", static_cast<std::size_t>(h)}, {"format", format}, {"ms", ms}},
            std::move(payload));
}

}  // namespace ffe
