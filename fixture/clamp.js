export function clamp(value, min, max) {
  if (min > max) {
    throw new Error("min must be <= max");
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
