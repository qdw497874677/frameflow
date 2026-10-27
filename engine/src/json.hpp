// Minimal JSON value + parser/serializer for the engine protocol and stock files.
#pragma once
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace ffe {

class Json;
using JsonArray = std::vector<Json>;
using JsonObject = std::map<std::string, Json>;

class JsonError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class Json {
 public:
  using Value = std::variant<std::nullptr_t, bool, double, std::string,
                             std::shared_ptr<JsonArray>, std::shared_ptr<JsonObject>>;

  Json() : v_(nullptr) {}
  Json(std::nullptr_t) : v_(nullptr) {}
  Json(bool b) : v_(b) {}
  Json(double d) : v_(d) {}
  Json(int i) : v_(static_cast<double>(i)) {}
  Json(long long i) : v_(static_cast<double>(i)) {}
  Json(std::size_t i) : v_(static_cast<double>(i)) {}
  Json(const char* s) : v_(std::string(s)) {}
  Json(std::string s) : v_(std::move(s)) {}
  Json(JsonArray a) : v_(std::make_shared<JsonArray>(std::move(a))) {}
  Json(JsonObject o) : v_(std::make_shared<JsonObject>(std::move(o))) {}

  static Json parse(std::string_view text);
  std::string dump() const;

  bool is_null() const { return std::holds_alternative<std::nullptr_t>(v_); }
  bool is_bool() const { return std::holds_alternative<bool>(v_); }
  bool is_number() const { return std::holds_alternative<double>(v_); }
  bool is_string() const { return std::holds_alternative<std::string>(v_); }
  bool is_array() const { return std::holds_alternative<std::shared_ptr<JsonArray>>(v_); }
  bool is_object() const { return std::holds_alternative<std::shared_ptr<JsonObject>>(v_); }

  bool as_bool() const;
  double as_number() const;
  const std::string& as_string() const;
  const JsonArray& as_array() const;
  const JsonObject& as_object() const;

  // Object access; returns a null Json when the key is missing.
  const Json& operator[](const std::string& key) const;
  bool has(const std::string& key) const;

  double number_or(const std::string& key, double fallback) const;
  std::string string_or(const std::string& key, const std::string& fallback) const;
  std::vector<double> numbers() const;  // array of numbers

 private:
  Value v_;
};

}  // namespace ffe
