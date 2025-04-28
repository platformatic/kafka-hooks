export const mediaTypes = 'application/binary'

export function serializer (value) {
  return value.reverse()
}

export function deserializer (value) {
  return value.reverse()
}
