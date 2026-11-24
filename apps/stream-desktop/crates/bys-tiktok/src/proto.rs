//! Minimal protobuf wire-format reader and writer (written for this crate, no dependencies).
//! Only what TikTok webcast frames need: varints, length-delimited fields and skipping the rest.
//! Every read is bounds-checked; malformed input is an error, never a panic.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtoError(pub &'static str);

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "malformed protobuf: {}", self.0)
    }
}
impl std::error::Error for ProtoError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Value<'a> {
    Varint(u64),
    Fixed64(u64),
    Bytes(&'a [u8]),
    Fixed32(u32),
}

impl<'a> Value<'a> {
    pub fn as_u64(self) -> Option<u64> {
        match self {
            Value::Varint(v) | Value::Fixed64(v) => Some(v),
            Value::Fixed32(v) => Some(u64::from(v)),
            Value::Bytes(_) => None,
        }
    }
    pub fn as_bytes(self) -> Option<&'a [u8]> {
        match self {
            Value::Bytes(b) => Some(b),
            _ => None,
        }
    }
    /// Lossy UTF-8 is not accepted: invalid text is treated as absent.
    pub fn as_str(self) -> Option<&'a str> {
        self.as_bytes().and_then(|b| std::str::from_utf8(b).ok())
    }
}

/// Iterates `(field number, value)` over one message's bytes.
#[derive(Debug, Clone)]
pub struct Fields<'a> {
    data: &'a [u8],
    pos: usize,
    failed: bool,
}

pub fn fields(data: &[u8]) -> Fields<'_> {
    Fields { data, pos: 0, failed: false }
}

fn varint(data: &[u8], pos: &mut usize) -> Result<u64, ProtoError> {
    let mut out: u64 = 0;
    for shift in (0..64).step_by(7) {
        let byte = *data.get(*pos).ok_or(ProtoError("truncated varint"))?;
        *pos += 1;
        out |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(out);
        }
    }
    Err(ProtoError("varint longer than 10 bytes"))
}

impl<'a> Fields<'a> {
    fn step(&mut self) -> Result<(u32, Value<'a>), ProtoError> {
        let key = varint(self.data, &mut self.pos)?;
        let field = u32::try_from(key >> 3).map_err(|_| ProtoError("field number too large"))?;
        if field == 0 {
            return Err(ProtoError("field number 0"));
        }
        let value = match key & 7 {
            0 => Value::Varint(varint(self.data, &mut self.pos)?),
            1 => {
                let b = self.data.get(self.pos..self.pos + 8).ok_or(ProtoError("truncated fixed64"))?;
                self.pos += 8;
                Value::Fixed64(u64::from_le_bytes(b.try_into().map_err(|_| ProtoError("fixed64"))?))
            }
            2 => {
                let len = usize::try_from(varint(self.data, &mut self.pos)?).map_err(|_| ProtoError("length too large"))?;
                let end = self.pos.checked_add(len).ok_or(ProtoError("length overflow"))?;
                let b = self.data.get(self.pos..end).ok_or(ProtoError("truncated bytes"))?;
                self.pos = end;
                Value::Bytes(b)
            }
            5 => {
                let b = self.data.get(self.pos..self.pos + 4).ok_or(ProtoError("truncated fixed32"))?;
                self.pos += 4;
                Value::Fixed32(u32::from_le_bytes(b.try_into().map_err(|_| ProtoError("fixed32"))?))
            }
            _ => return Err(ProtoError("unsupported wire type")),
        };
        Ok((field, value))
    }
}

impl<'a> Iterator for Fields<'a> {
    type Item = Result<(u32, Value<'a>), ProtoError>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.pos >= self.data.len() {
            return None;
        }
        let r = self.step();
        if r.is_err() {
            self.failed = true;
        }
        Some(r)
    }
}

/// Collect every field of a message, failing on the first malformed one.
pub fn parse(data: &[u8]) -> Result<Vec<(u32, Value<'_>)>, ProtoError> {
    fields(data).collect()
}

/// First value of `field`.
pub fn get<'a>(msg: &[(u32, Value<'a>)], field: u32) -> Option<Value<'a>> {
    msg.iter().find(|(f, _)| *f == field).map(|(_, v)| *v)
}

/// Every value of a repeated `field`.
pub fn all<'a>(msg: &'a [(u32, Value<'a>)], field: u32) -> impl Iterator<Item = Value<'a>> + 'a {
    msg.iter().filter(move |(f, _)| *f == field).map(|(_, v)| *v)
}

// ---- writer (acknowledgements and tests) -----------------------------------------------------------

pub fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

pub fn put_uint(out: &mut Vec<u8>, field: u32, v: u64) {
    put_varint(out, u64::from(field) << 3);
    put_varint(out, v);
}

pub fn put_bytes(out: &mut Vec<u8>, field: u32, b: &[u8]) {
    put_varint(out, (u64::from(field) << 3) | 2);
    put_varint(out, b.len() as u64);
    out.extend_from_slice(b);
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn round_trip_and_known_bytes() {
        let mut m = vec![];
        put_uint(&mut m, 1, 150);
        put_bytes(&mut m, 3, b"hi");
        assert_eq!(m, [0x08, 0x96, 0x01, 0x1a, 0x02, b'h', b'i'], "protobuf spec example for 150");
        let f = parse(&m).unwrap();
        assert_eq!(get(&f, 1).and_then(Value::as_u64), Some(150));
        assert_eq!(get(&f, 3).and_then(Value::as_str), Some("hi"));
        assert_eq!(get(&f, 9), None);
    }

    #[test]
    fn malformed_input_is_an_error() {
        assert!(parse(&[0x1a, 0x05, b'a']).is_err(), "length past the end");
        assert!(
            parse(&[0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]).is_err(),
            "11-byte varint"
        );
        assert!(parse(&[0x00, 0x01]).is_err(), "field 0");
        assert!(parse(&[0x0b]).is_err(), "group wire type");
        assert!(parse(&[0x1a, 0xff, 0xff, 0xff, 0xff, 0x0f]).is_err(), "huge length");
        assert!(
            parse(&[0x1a, 0x02, 0xff, 0xfe]).map(|f| get(&f, 3).and_then(Value::as_str)).unwrap().is_none(),
            "invalid UTF-8 is absent"
        );
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut x: u64 = 0xdead_beef_cafe_f00d;
        for len in 0..3000usize {
            let buf: Vec<u8> = (0..len % 131)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    (x & 0xff) as u8
                })
                .collect();
            let _ = parse(&buf);
        }
    }
}
