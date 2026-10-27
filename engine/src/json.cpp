#include "json.hpp"

#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>

namespace ffe {
namespace {

class Parser {
 public:
  explicit Parser(std::string_view s) : s_(s) {}

  Json document() {
    Json v = value(0);
    ws();
    if (i_ != s_.size()) fail("trailing characters");
    return v;
  }

 private:
  static constexpr int kMaxDepth = 64;
  std::string_view s_;
  std::size_t i_ = 0;

  [[noreturn]] void fail(const char* what) const {
    throw JsonError(std::string("json: ") + what + " at offset " + std::to_string(i_));
  }
  void ws() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\n' || s_[i_] == '\r' || s_[i_] == '\t')) ++i_;
  }
  char peek() {
    ws();
    if (i_ >= s_.size()) fail("unexpected end");
    return s_[i_];
  }
  void expect(std::string_view lit) {
    if (s_.substr(i_, lit.size()) != lit) fail("invalid literal");
    i_ += lit.size();
  }

  Json value(int depth) {
    if (depth > kMaxDepth) fail("nesting too deep");
    char c = peek();
    switch (c) {
      case '{': return object(depth);
      case '[': return array(depth);
      case '"': return Json(string());
      case 't': expect("true"); return Json(true);
      case 'f': expect("false"); return Json(false);
      case 'n': expect("null"); return Json(nullptr);
      default: return Json(number());
    }
  }

  Json object(int depth) {
    ++i_;
    JsonObject o;
    if (peek() == '}') { ++i_; return Json(std::move(o)); }
    for (;;) {
      if (peek() != '"') fail("expected key");
      std::string k = string();
      if (peek() != ':') fail("expected ':'");
      ++i_;
      o[std::move(k)] = value(depth + 1);
      char c = peek();
      ++i_;
      if (c == '}') return Json(std::move(o));
      if (c != ',') fail("expected ',' or '}'");
    }
  }

  Json array(int depth) {
    ++i_;
    JsonArray a;
    if (peek() == ']') { ++i_; return Json(std::move(a)); }
    for (;;) {
      a.push_back(value(depth + 1));
      char c = peek();
      ++i_;
      if (c == ']') return Json(std::move(a));
      if (c != ',') fail("expected ',' or ']'");
    }
  }

  double number() {
    std::size_t start = i_;
    if (i_ < s_.size() && (s_[i_] == '-' || s_[i_] == '+')) ++i_;
    while (i_ < s_.size() && (std::isdigit(static_cast<unsigned char>(s_[i_])) || s_[i_] == '.' ||
                              s_[i_] == 'e' || s_[i_] == 'E' || s_[i_] == '-' || s_[i_] == '+'))
      ++i_;
    double d = 0;
    auto r = std::from_chars(s_.data() + start, s_.data() + i_, d);
    if (r.ec != std::errc() || r.ptr != s_.data() + i_ || start == i_) fail("invalid number");
    return d;
  }

  static void utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) out += static_cast<char>(cp);
    else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else { out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
  }

  unsigned hex4() {
    if (i_ + 4 > s_.size()) fail("bad escape");
    unsigned v = 0;
    auto r = std::from_chars(s_.data() + i_, s_.data() + i_ + 4, v, 16);
    if (r.ptr != s_.data() + i_ + 4) fail("bad escape");
    i_ += 4;
    return v;
  }

  std::string string() {
    ++i_;
    std::string out;
    while (i_ < s_.size()) {
      char c = s_[i_++];
      if (c == '"') return out;
      if (static_cast<unsigned char>(c) < 0x20) fail("control character in string");
      if (c != '\\') { out += c; continue; }
      if (i_ >= s_.size()) break;
      char e = s_[i_++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned cp = hex4();
          if (cp >= 0xD800 && cp < 0xDC00 && s_.substr(i_, 2) == "\\u") {
            i_ += 2;
            unsigned lo = hex4();
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: fail("bad escape");
      }
    }
    fail("unterminated string");
  }
};

void dump_string(std::string& out, const std::string& s) {
  out += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  out += '"';
}

void dump_value(std::string& out, const Json& v) {
  if (v.is_null()) out += "null";
  else if (v.is_bool()) out += v.as_bool() ? "true" : "false";
  else if (v.is_number()) {
    double d = v.as_number();
    if (!std::isfinite(d)) { out += "null"; return; }
    char buf[32];
    auto r = std::to_chars(buf, buf + sizeof buf, d);
    out.append(buf, r.ptr);
  } else if (v.is_string()) dump_string(out, v.as_string());
  else if (v.is_array()) {
    out += '[';
    bool first = true;
    for (const auto& e : v.as_array()) {
      if (!first) out += ',';
      first = false;
      dump_value(out, e);
    }
    out += ']';
  } else {
    out += '{';
    bool first = true;
    for (const auto& [k, e] : v.as_object()) {
      if (!first) out += ',';
      first = false;
      dump_string(out, k);
      out += ':';
      dump_value(out, e);
    }
    out += '}';
  }
}

const Json& null_json() {
  static const Json n;
  return n;
}

}  // namespace

Json Json::parse(std::string_view text) { return Parser(text).document(); }

std::string Json::dump() const {
  std::string out;
  dump_value(out, *this);
  return out;
}

bool Json::as_bool() const {
  if (!is_bool()) throw JsonError("json: not a bool");
  return std::get<bool>(v_);
}
double Json::as_number() const {
  if (!is_number()) throw JsonError("json: not a number");
  return std::get<double>(v_);
}
const std::string& Json::as_string() const {
  if (!is_string()) throw JsonError("json: not a string");
  return std::get<std::string>(v_);
}
const JsonArray& Json::as_array() const {
  if (!is_array()) throw JsonError("json: not an array");
  return *std::get<std::shared_ptr<JsonArray>>(v_);
}
const JsonObject& Json::as_object() const {
  if (!is_object()) throw JsonError("json: not an object");
  return *std::get<std::shared_ptr<JsonObject>>(v_);
}

const Json& Json::operator[](const std::string& key) const {
  if (!is_object()) return null_json();
  const auto& o = as_object();
  auto it = o.find(key);
  return it == o.end() ? null_json() : it->second;
}

bool Json::has(const std::string& key) const { return is_object() && as_object().count(key) > 0; }

double Json::number_or(const std::string& key, double fallback) const {
  const Json& v = (*this)[key];
  return v.is_number() ? v.as_number() : fallback;
}

std::string Json::string_or(const std::string& key, const std::string& fallback) const {
  const Json& v = (*this)[key];
  return v.is_string() ? v.as_string() : fallback;
}

std::vector<double> Json::numbers() const {
  std::vector<double> out;
  for (const auto& e : as_array()) out.push_back(e.as_number());
  return out;
}

}  // namespace ffe
