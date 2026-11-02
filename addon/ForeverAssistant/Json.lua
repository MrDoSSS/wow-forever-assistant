-- Addon JSON encoder. Match bridge JSON.stringify output: no whitespace,
-- UTF-8 without Unicode escapes except controls. Mark arrays explicitly
-- with Json.array, use Json.null for null, and sort object keys.
local _, FA = ...
local Json = {}
FA.Json = Json

local ARRAY = {}
Json.null = setmetatable({}, { __tostring = function() return "null" end })

function Json.array(items)
  return setmetatable(items or {}, ARRAY)
end

function Json.isArray(value)
  return getmetatable(value) == ARRAY
end

local SHORT = { [8] = "\\b", [9] = "\\t", [10] = "\\n", [12] = "\\f", [13] = "\\r" }

local function escapeChar(ch)
  if ch == '"' then return '\\"' end
  if ch == "\\" then return "\\\\" end
  local code = string.byte(ch)
  if code == 127 then return ch end
  return SHORT[code] or string.format("\\u%04x", code)
end

function Json.string(value)
  return '"' .. string.gsub(value, '[%c"\\]', escapeChar) .. '"'
end

local MAX_SAFE = 9007199254740991

local function number(value)
  if value ~= value or value == math.huge or value == -math.huge then
    error("JSON: non-finite number")
  end
  if value == math.floor(value) then
    if value > MAX_SAFE or value < -MAX_SAFE then error("JSON: unsafe integer") end
    return string.format("%.0f", value)
  end
  return string.format("%.17g", value)
end

local encode

local function object(value, out)
  local keys = {}
  for key in pairs(value) do
    if type(key) ~= "string" then error("JSON: object key must be a string") end
    keys[#keys + 1] = key
  end
  table.sort(keys)
  out[#out + 1] = "{"
  for i, key in ipairs(keys) do
    if i > 1 then out[#out + 1] = "," end
    out[#out + 1] = Json.string(key)
    out[#out + 1] = ":"
    encode(value[key], out)
  end
  out[#out + 1] = "}"
end

encode = function(value, out)
  local kind = type(value)
  if value == Json.null then
    out[#out + 1] = "null"
  elseif kind == "boolean" then
    out[#out + 1] = value and "true" or "false"
  elseif kind == "number" then
    out[#out + 1] = number(value)
  elseif kind == "string" then
    out[#out + 1] = Json.string(value)
  elseif kind == "table" then
    if Json.isArray(value) then
      out[#out + 1] = "["
      for i = 1, #value do
        if i > 1 then out[#out + 1] = "," end
        encode(value[i], out)
      end
      out[#out + 1] = "]"
    else
      object(value, out)
    end
  else
    error("JSON: unsupported value " .. kind)
  end
end

function Json.encode(value)
  local out = {}
  encode(value, out)
  return table.concat(out)
end
