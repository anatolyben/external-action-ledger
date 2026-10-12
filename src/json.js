/**
 * Clone the JSON subset supported identically by JavaScript and PostgreSQL JSONB.
 * Core values use tighter limits; durable records need room for their wrappers
 * and for multiple individually bounded receipts.
 */
export function copyJson(value, { label = 'Value', maxDepth = 128, maxBytes = Infinity } = {}) {
  const ancestors = new Set();

  function unicode(text, part) {
    if (text.includes('\0') || !text.isWellFormed()) {
      throw new TypeError(`${label} ${part} must be valid Unicode without NUL for PostgreSQL JSONB`);
    }
  }

  function visit(item, depth) {
    if (depth > maxDepth) throw new TypeError(`${label} exceeds ${maxDepth} JSON levels`);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      unicode(item, 'strings');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) {
      throw new TypeError(`${label} must be finite, acyclic JSON`);
    }
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain plain JSON objects`);
    }
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError(`${label} cannot contain symbol properties`);

    ancestors.add(item);
    let normalized;
    const names = Object.getOwnPropertyNames(item);
    if (array) {
      // Include non-enumerable properties in this check: JSON must never silently
      // discard an extra property, a sparse slot, or a custom array accessor.
      if (names.length !== item.length + 1 || names.at(-1) !== 'length' ||
          names.slice(0, -1).some((name, index) => name !== String(index))) {
        throw new TypeError(`${label} must contain dense JSON arrays without extra properties`);
      }
      normalized = new Array(item.length);
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${label} must contain enumerable JSON data properties, not accessors`);
        }
        normalized[index] = visit(descriptor.value, depth + 1);
      }
    } else {
      normalized = Object.create(null);
      for (const key of names.sort()) {
        unicode(key, 'keys');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${label} must contain enumerable JSON data properties, not accessors`);
        }
        normalized[key] = visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
    return normalized;
  }

  const encoded = JSON.stringify(visit(value, 0));
  if (maxBytes !== Infinity && Buffer.byteLength(encoded) > maxBytes) {
    throw new TypeError(`${label} exceeds ${maxBytes} JSON bytes`);
  }
  return JSON.parse(encoded);
}
