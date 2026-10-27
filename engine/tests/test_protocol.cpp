#include <cstdio>

#include "check.hpp"
#include "protocol.hpp"

using namespace ffe;

static std::FILE* stream_of(const std::vector<std::uint8_t>& bytes) {
  std::FILE* f = std::tmpfile();
  std::fwrite(bytes.data(), 1, bytes.size(), f);
  std::rewind(f);
  return f;
}

TEST(round_trips_frames) {
  Frame a{Json(JsonObject{{"op", "render"}, {"id", 3}}), {1, 2, 3, 250}};
  Frame b{Json(JsonObject{{"op", "hello"}}), {}};
  auto bytes = encode_frame(a);
  auto more = encode_frame(b);
  bytes.insert(bytes.end(), more.begin(), more.end());
  std::FILE* f = stream_of(bytes);
  auto r1 = read_frame(f);
  auto r2 = read_frame(f);
  auto r3 = read_frame(f);
  CHECK(r1 && r1->header["op"].as_string() == "render" && r1->payload == a.payload);
  CHECK(r2 && r2->header["op"].as_string() == "hello" && r2->payload.empty());
  CHECK(!r3);  // clean EOF
  std::fclose(f);
}

TEST(header_layout_is_little_endian) {
  auto bytes = encode_frame(Frame{Json(JsonObject{}), {9}});
  CHECK(bytes.size() == 4 + 4 + 2 + 4 + 1);
  CHECK(bytes[0] == 'F' && bytes[3] == '1');
  CHECK(bytes[4] == 2 && bytes[5] == 0);  // header "{}" length
  CHECK(bytes[10] == 1 && bytes[14] == 9);
}

TEST(rejects_bad_frames) {
  auto good = encode_frame(Frame{Json(JsonObject{{"op", "x"}}), {1, 2}});
  auto truncated = good;
  truncated.pop_back();
  auto bad_magic = good;
  bad_magic[0] = 'X';
  std::vector<std::uint8_t> not_object = encode_frame(Frame{Json(JsonArray{}), {}});
  std::vector<std::uint8_t> huge = {'F', 'F', 'E', '1', 0xff, 0xff, 0xff, 0x7f};
  for (const auto* bytes : {&truncated, &bad_magic, &not_object, &huge}) {
    std::FILE* f = stream_of(*bytes);
    CHECK_THROWS(read_frame(f));
    std::fclose(f);
  }
}

TEST_MAIN
