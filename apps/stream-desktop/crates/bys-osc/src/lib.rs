//! OSC 1.0 message codec for BetterYTS Stream (VRChat avatar parameters, chatbox, live input).
//! Written from the OSC 1.0 specification. Decoding treats every packet as hostile: sizes are
//! bounded, every read is checked, and malformed input is an error, never a panic.
//!
//! Supported argument types: `i` (int32), `f` (float32), `s` (string), `T`/`F` (booleans).
//! Bundles (`#bundle`) are rejected for now; VRChat sends plain messages.

use std::fmt;

/// Largest packet accepted (UDP datagrams from VRChat are far smaller).
pub const MAX_PACKET: usize = 64 * 1024;
pub const MAX_ADDRESS: usize = 256;
pub const MAX_ARGS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Int(i32),
    Float(f32),
    Str(String),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub address: String,
    pub args: Vec<Arg>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscError {
    TooLarge,
    Truncated,
    BadAddress,
    BadTypeTags,
    UnsupportedType(u8),
    BadString,
    TooManyArgs,
    Bundle,
    NonFinite,
}

impl fmt::Display for OscError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            OscError::TooLarge => "packet too large",
            OscError::Truncated => "packet truncated",
            OscError::BadAddress => "invalid OSC address",
            OscError::BadTypeTags => "invalid type tag string",
            OscError::UnsupportedType(_) => "unsupported argument type",
            OscError::BadString => "invalid OSC string",
            OscError::TooManyArgs => "too many arguments",
            OscError::Bundle => "OSC bundles are not supported",
            OscError::NonFinite => "float argument is not finite",
        };
        f.write_str(s)
    }
}
impl std::error::Error for OscError {}

/// Address rules: starts with '/', printable ASCII, no spaces or OSC pattern characters.
pub fn valid_address(address: &str) -> bool {
    address.len() > 1
        && address.len() <= MAX_ADDRESS
        && address.starts_with('/')
        && address.bytes().all(|b| (0x21..=0x7e).contains(&b) && !b"#*,?[]{}".contains(&b))
}

fn pad4(len: usize) -> usize {
    (len + 4) & !3 // string bytes + at least one NUL, rounded up to a multiple of 4
}

fn put_str(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(s.as_bytes());
    buf.resize(buf.len() + (pad4(s.len()) - s.len()), 0);
}

impl Message {
    pub fn new(address: &str, args: Vec<Arg>) -> Result<Message, OscError> {
        if !valid_address(address) {
            return Err(OscError::BadAddress);
        }
        if args.len() > MAX_ARGS {
            return Err(OscError::TooManyArgs);
        }
        for a in &args {
            match a {
                Arg::Float(f) if !f.is_finite() => return Err(OscError::NonFinite),
                Arg::Str(s) if s.contains('\0') => return Err(OscError::BadString),
                _ => {}
            }
        }
        Ok(Message {
            address: address.to_owned(),
            args,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(64);
        put_str(&mut buf, &self.address);
        let mut tags = String::from(",");
        for a in &self.args {
            tags.push(match a {
                Arg::Int(_) => 'i',
                Arg::Float(_) => 'f',
                Arg::Str(_) => 's',
                Arg::Bool(true) => 'T',
                Arg::Bool(false) => 'F',
            });
        }
        put_str(&mut buf, &tags);
        for a in &self.args {
            match a {
                Arg::Int(i) => buf.extend_from_slice(&i.to_be_bytes()),
                Arg::Float(f) => buf.extend_from_slice(&f.to_be_bytes()),
                Arg::Str(s) => put_str(&mut buf, s),
                Arg::Bool(_) => {}
            }
        }
        buf
    }
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], OscError> {
        let end = self.pos.checked_add(n).ok_or(OscError::Truncated)?;
        let slice = self.data.get(self.pos..end).ok_or(OscError::Truncated)?;
        self.pos = end;
        Ok(slice)
    }

    fn string(&mut self) -> Result<String, OscError> {
        let rest = self.data.get(self.pos..).ok_or(OscError::Truncated)?;
        let len = rest.iter().position(|&b| b == 0).ok_or(OscError::BadString)?;
        let bytes = self.take(pad4(len))?;
        let (text, padding) = bytes.split_at(len);
        if padding.iter().any(|&b| b != 0) {
            return Err(OscError::BadString);
        }
        String::from_utf8(text.to_vec()).map_err(|_| OscError::BadString)
    }

    fn word(&mut self) -> Result<[u8; 4], OscError> {
        let b = self.take(4)?;
        let mut w = [0u8; 4];
        w.copy_from_slice(b);
        Ok(w)
    }
}

pub fn decode(packet: &[u8]) -> Result<Message, OscError> {
    if packet.len() > MAX_PACKET {
        return Err(OscError::TooLarge);
    }
    if !packet.len().is_multiple_of(4) {
        return Err(OscError::Truncated);
    }
    let mut r = Reader { data: packet, pos: 0 };
    let address = r.string()?;
    if address == "#bundle" {
        return Err(OscError::Bundle);
    }
    if !valid_address(&address) {
        return Err(OscError::BadAddress);
    }
    // A message with no type tag string is legal in old OSC; treat it as no arguments.
    if r.pos == packet.len() {
        return Ok(Message { address, args: vec![] });
    }
    let tags = r.string()?;
    let tags = tags.strip_prefix(',').ok_or(OscError::BadTypeTags)?;
    if tags.len() > MAX_ARGS {
        return Err(OscError::TooManyArgs);
    }
    let mut args = Vec::with_capacity(tags.len());
    for t in tags.bytes() {
        args.push(match t {
            b'i' => Arg::Int(i32::from_be_bytes(r.word()?)),
            b'f' => {
                let f = f32::from_be_bytes(r.word()?);
                if !f.is_finite() {
                    return Err(OscError::NonFinite);
                }
                Arg::Float(f)
            }
            b's' => Arg::Str(r.string()?),
            b'T' => Arg::Bool(true),
            b'F' => Arg::Bool(false),
            other => return Err(OscError::UnsupportedType(other)),
        });
    }
    if r.pos != packet.len() {
        return Err(OscError::Truncated); // trailing bytes
    }
    Ok(Message { address, args })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
    use super::*;

    #[test]
    fn round_trip_vrchat_parameter_and_chatbox() {
        let m = Message::new("/avatar/parameters/Ears", vec![Arg::Float(0.5)]).unwrap();
        assert_eq!(decode(&m.encode()).unwrap(), m);
        let chat = Message::new(
            "/chatbox/input",
            vec![Arg::Str("Now playing: Song".into()), Arg::Bool(true), Arg::Bool(false), Arg::Int(-7)],
        )
        .unwrap();
        assert_eq!(decode(&chat.encode()).unwrap(), chat);
    }

    #[test]
    fn known_wire_format() {
        // "/a\0\0" ",i\0\0" 00 00 00 2a
        let bytes = [b'/', b'a', 0, 0, b',', b'i', 0, 0, 0, 0, 0, 42];
        assert_eq!(
            decode(&bytes).unwrap(),
            Message {
                address: "/a".into(),
                args: vec![Arg::Int(42)]
            }
        );
        assert_eq!(Message::new("/a", vec![Arg::Int(42)]).unwrap().encode(), bytes);
    }

    #[test]
    fn hostile_packets_are_errors() {
        assert_eq!(decode(&[0u8; MAX_PACKET + 4]), Err(OscError::TooLarge));
        assert_eq!(decode(b"/a\0"), Err(OscError::Truncated));
        assert_eq!(decode(b"#bundle\0"), Err(OscError::Bundle));
        assert_eq!(decode(b"/a\0\0,i\0\0"), Err(OscError::Truncated), "missing int");
        assert_eq!(decode(b"/a\0\0,b\0\0"), Err(OscError::UnsupportedType(b'b')));
        assert_eq!(decode(b"/a\0\0i\0\0\0"), Err(OscError::BadTypeTags));
        assert_eq!(decode(b"/a b\0\0\0\0"), Err(OscError::BadAddress));
        assert_eq!(decode(b"/a\0x,\0\0\0"), Err(OscError::BadString), "non-zero padding");
        let nan = [b'/', b'a', 0, 0, b',', b'f', 0, 0, 0x7f, 0xc0, 0, 0];
        assert_eq!(decode(&nan), Err(OscError::NonFinite));
        assert!(Message::new("no-slash", vec![]).is_err());
        assert!(Message::new("/a", vec![Arg::Float(f32::INFINITY)]).is_err());
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut x: u64 = 0x1234_5678_9abc_def0;
        for len in 0..2000usize {
            let mut buf = Vec::with_capacity(len % 97);
            for _ in 0..(len % 97) {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                buf.push((x & 0xff) as u8);
            }
            if len % 3 == 0 && !buf.is_empty() {
                buf[0] = b'/';
            }
            let _ = decode(&buf);
        }
    }
}
