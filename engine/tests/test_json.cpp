#include "check.hpp"
#include "json.hpp"

using ffe::Json;

TEST(parses_scalars_and_nesting) {
  Json j = Json::parse(R"( {"a": [1, -2.5e2, true, false, null], "b": {"c": "x\"y\u00e9"}} )");
  CHECK(j["a"].as_array().size() == 5);
  CHECK_NEAR(j["a"].as_array()[1].as_number(), -250.0, 0);
  CHECK(j["a"].as_array()[2].as_bool());
  CHECK(j["a"].as_array()[4].is_null());
  CHECK(j["b"]["c"].as_string() == "x\"y\xc3\xa9");
}

TEST(missing_keys_are_null) {
  Json j = Json::parse("{}");
  CHECK(j["nope"].is_null());
  CHECK_NEAR(j.number_or("nope", 7), 7, 0);
  CHECK(j.string_or("nope", "d") == "d");
}

TEST(round_trips_through_dump) {
  const char* text = R"({"a":[1,2.5,"s\n"],"b":true,"c":null})";
  CHECK(Json::parse(text).dump() == text);
  CHECK(Json::parse(Json::parse(text).dump()).dump() == text);
}

TEST(rejects_malformed_input) {
  CHECK_THROWS(Json::parse("{"));
  CHECK_THROWS(Json::parse("[1,]"));
  CHECK_THROWS(Json::parse("{\"a\" 1}"));
  CHECK_THROWS(Json::parse("01x"));
  CHECK_THROWS(Json::parse("\"unterminated"));
  CHECK_THROWS(Json::parse("[1] 2"));
  CHECK_THROWS(Json::parse(std::string(100, '[') + std::string(100, ']')));
}

TEST(type_errors_throw) {
  Json j = Json::parse("[1]");
  CHECK_THROWS(j.as_object());
  CHECK_THROWS(j.as_array()[0].as_string());
}

TEST_MAIN
