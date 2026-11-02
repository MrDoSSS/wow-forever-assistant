-- Unsigned 32-bit operations. Use client bit (LuaBitOp) when available;
-- otherwise fall back to nibble-based arithmetic.
local _, FA = ...
local Bit = {}
FA.Bit = Bit

local MOD = 4294967296

local function norm(x)
  return x % MOD
end

local native = bit
if type(native) == "table" and native.band and native.bor and native.bxor and native.rshift and native.lshift then
  function Bit.band(a, b) return norm(native.band(a, b)) end
  function Bit.bor(a, b) return norm(native.bor(a, b)) end
  function Bit.bxor(a, b) return norm(native.bxor(a, b)) end
  function Bit.bnot(a) return norm(native.bnot(a)) end
  function Bit.rshift(a, n) return norm(native.rshift(a, n)) end
  function Bit.lshift(a, n) return norm(native.lshift(a, n)) end
  Bit.native = true
else
  local AND, OR, XOR = {}, {}, {}
  for a = 0, 15 do
    AND[a], OR[a], XOR[a] = {}, {}, {}
    for b = 0, 15 do
      local r_and, r_or, r_xor, weight = 0, 0, 0, 1
      local x, y = a, b
      for _ = 1, 4 do
        local bx, by = x % 2, y % 2
        if bx == 1 and by == 1 then r_and = r_and + weight end
        if bx == 1 or by == 1 then r_or = r_or + weight end
        if bx ~= by then r_xor = r_xor + weight end
        x, y = math.floor(x / 2), math.floor(y / 2)
        weight = weight * 2
      end
      AND[a][b], OR[a][b], XOR[a][b] = r_and, r_or, r_xor
    end
  end

  local function op(table, a, b)
    a, b = norm(a), norm(b)
    local result, weight = 0, 1
    for _ = 1, 8 do
      result = result + table[a % 16][b % 16] * weight
      a, b = math.floor(a / 16), math.floor(b / 16)
      weight = weight * 16
    end
    return result
  end

  function Bit.band(a, b) return op(AND, a, b) end
  function Bit.bor(a, b) return op(OR, a, b) end
  function Bit.bxor(a, b) return op(XOR, a, b) end
  function Bit.bnot(a) return MOD - 1 - norm(a) end
  function Bit.rshift(a, n) return math.floor(norm(a) / 2 ^ n) end
  function Bit.lshift(a, n) return norm(norm(a) * 2 ^ n) end
  Bit.native = false
end

function Bit.rrotate(x, n)
  return Bit.bor(Bit.rshift(x, n), Bit.lshift(x, 32 - n))
end
