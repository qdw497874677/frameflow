#include "protocol.hpp"

#include <cstring>
#include <string>

namespace ffe {
namespace {

constexpr char kMagic[4] = {'F', 'F', 'E', '1'};

bool read_exact(std::FILE* in, void* dst, std::size_t n, bool eof_ok) {
  auto* p = static_cast<std::uint8_t*>(dst);
  std::size_t got = 0;
  while (got < n) {
    std::size_t r = std::fread(p + got, 1, n - got, in);
    if (r == 0) {
      if (eof_ok && got == 0) return false;
      throw ProtocolError("truncated frame");
    }
    got += r;
  }
  return true;
}

std::uint32_t read_u32(std::FILE* in) {
  std::uint8_t b[4];
  read_exact(in, b, 4, false);
  return std::uint32_t(b[0]) | std::uint32_t(b[1]) << 8 | std::uint32_t(b[2]) << 16 | std::uint32_t(b[3]) << 24;
}

void put_u32(std::vector<std::uint8_t>& out, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(v >> (8 * i)));
}

}  // namespace

std::optional<Frame> read_frame(std::FILE* in) {
  char magic[4];
  if (!read_exact(in, magic, 4, true)) return std::nullopt;
  if (std::memcmp(magic, kMagic, 4) != 0) throw ProtocolError("bad magic");
  std::uint32_t hlen = read_u32(in);
  if (hlen > kMaxHeaderBytes) throw ProtocolError("header too large");
  std::string header(hlen, '\0');
  read_exact(in, header.data(), hlen, false);
  std::uint32_t plen = read_u32(in);
  if (plen > kMaxPayloadBytes) throw ProtocolError("payload too large");
  Frame f;
  f.payload.resize(plen);
  if (plen) read_exact(in, f.payload.data(), plen, false);
  try {
    f.header = Json::parse(header);
  } catch (const JsonError& e) {
    throw ProtocolError(std::string("bad header: ") + e.what());
  }
  if (!f.header.is_object()) throw ProtocolError("header must be an object");
  return f;
}

std::vector<std::uint8_t> encode_frame(const Frame& frame) {
  std::string h = frame.header.dump();
  std::vector<std::uint8_t> out;
  out.reserve(12 + h.size() + frame.payload.size());
  out.insert(out.end(), kMagic, kMagic + 4);
  put_u32(out, static_cast<std::uint32_t>(h.size()));
  out.insert(out.end(), h.begin(), h.end());
  put_u32(out, static_cast<std::uint32_t>(frame.payload.size()));
  out.insert(out.end(), frame.payload.begin(), frame.payload.end());
  return out;
}

void write_frame(std::FILE* out, const Frame& frame) {
  std::vector<std::uint8_t> bytes = encode_frame(frame);
  if (std::fwrite(bytes.data(), 1, bytes.size(), out) != bytes.size() || std::fflush(out) != 0)
    throw ProtocolError("write failed");
}

}  // namespace ffe
