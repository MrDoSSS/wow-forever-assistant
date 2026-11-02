-- Outgoing frame: 48-byte header + 1..1024-byte fragment + zeros,
-- 1152 bytes total; 3072 cells with three RGB bits each. Byte arrays are numeric tables.
local _, FA = ...
local Codec = {}
FA.Codec = Codec

Codec.COLS = 128
Codec.ROWS = 24
Codec.CELL = 4
Codec.OFFSET = 8
Codec.HEADER = 48
Codec.CAPACITY = 1152
Codec.MAX_FRAGMENT = 1024
Codec.MAX_FRAGMENTS = 128
Codec.MAX_MESSAGE = 131072
Codec.LOW = 8 / 255
Codec.HIGH = 247 / 255
Codec.KINDS = { HELLO = 1, QUERY = 2, CANCEL = 3, PRICE_RESULT = 4, RECEIPTS = 5, POLICY = 6, CLEAR_HISTORY = 7 }

function Codec.fletcher16(bytes, first, last)
  local a, b = 0, 0
  for i = first, last do
    a = (a + bytes[i]) % 255
    b = (b + a) % 255
  end
  return a + 256 * b
end

function Codec.fragmentCount(messageBytes)
  return math.ceil(messageBytes / Codec.MAX_FRAGMENT)
end

local function putLE(bytes, position, value, size)
  for i = 0, size - 1 do
    bytes[position + i] = value % 256
    value = math.floor(value / 256)
  end
end

-- message = { kind, origin (32 hex), sequence, bytes (UTF-8 JSON string) }
function Codec.frameBytes(message, index)
  local length = #message.bytes
  local count = Codec.fragmentCount(length)
  local first = index * Codec.MAX_FRAGMENT + 1
  local last = math.min(length, first + Codec.MAX_FRAGMENT - 1)
  local frame = {}
  for i = 1, Codec.CAPACITY do frame[i] = 0 end
  frame[1], frame[2], frame[3], frame[4] = 0x46, 0x41, 0x53, 0x31 -- "FAS1"
  frame[5] = 1
  frame[6] = message.kind
  putLE(frame, 7, Codec.HEADER, 2)
  for i = 0, 15 do
    frame[9 + i] = tonumber(string.sub(message.origin, i * 2 + 1, i * 2 + 2), 16)
  end
  putLE(frame, 25, message.sequence, 4)
  putLE(frame, 29, index, 2)
  putLE(frame, 31, count, 2)
  putLE(frame, 33, last - first + 1, 2)
  putLE(frame, 37, length, 4)
  for i = first, last do
    frame[Codec.HEADER + i - first + 1] = string.byte(message.bytes, i)
  end
  putLE(frame, 41, Codec.fletcher16(frame, Codec.HEADER + 1, Codec.HEADER + last - first + 1), 2)
  putLE(frame, 43, Codec.fletcher16(frame, 1, Codec.HEADER), 2)
  return frame
end

-- Cell value 0..7: R*4 + G*2 + B; visit R, G, B channels, most significant bit first.
function Codec.cells(frame)
  local cells = {}
  local total = Codec.COLS * Codec.ROWS
  for cell = 0, total - 1 do
    local value = 0
    for channel = 0, 2 do
      local bitIndex = cell * 3 + channel
      local byte = frame[math.floor(bitIndex / 8) + 1]
      local shift = 7 - bitIndex % 8
      value = value * 2 + math.floor(byte / 2 ^ shift) % 2
    end
    cells[cell + 1] = value
  end
  return cells
end

function Codec.cellColor(value)
  local r = math.floor(value / 4) % 2
  local g = math.floor(value / 2) % 2
  local b = value % 2
  local function level(on) return on == 1 and Codec.HIGH or Codec.LOW end
  return level(r), level(g), level(b)
end
