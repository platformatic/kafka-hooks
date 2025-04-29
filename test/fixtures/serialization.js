export const mediaTypes = 'application/binary'

export function serializer (value) {
  return Buffer.from(value.toString().toUpperCase(), 'utf-8')
}

export function deserializer (value) {
  return value.toString('utf-8').toLowerCase()
}
