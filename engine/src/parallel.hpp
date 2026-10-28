// Minimal fork-join helper shared by the LUT, render and spatial paths.
#pragma once
#include <algorithm>
#include <cstddef>
#include <functional>
#include <thread>
#include <vector>

namespace ffe {

// Calls fn(begin, end) on contiguous slices of [0, n); at most `threads` workers, >= min_chunk items each.
inline void run_parallel(std::size_t n, unsigned threads, const std::function<void(std::size_t, std::size_t)>& fn,
                         std::size_t min_chunk = 4096) {
  threads = std::max(1u, std::min<unsigned>(threads, static_cast<unsigned>((n + min_chunk - 1) / min_chunk)));
  if (threads == 1) { fn(0, n); return; }
  std::vector<std::thread> pool;
  std::size_t chunk = (n + threads - 1) / threads;
  for (unsigned t = 0; t < threads; ++t) {
    std::size_t a = t * chunk, b = std::min(n, a + chunk);
    if (a < b) pool.emplace_back(fn, a, b);
  }
  for (auto& th : pool) th.join();
}

}  // namespace ffe
