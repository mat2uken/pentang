//! 共通バイナリ電文プロトコル (Wire Format v1) の Rust 側実装。
//! `packages/core/include/core_wire.h` とバイト単位で一致させる。
//! Tauri 非依存。確保は caller 側。exeptionなし (Result で返す)。

pub const WIRE_SIZE: usize = 16;
pub const WIRE_MAGIC: u16 = 0x5742;
pub const WIRE_VERSION: u32 = 1;

pub const CMD_GET_INFO: u16 = 1;
pub const CMD_TRANSFORM: u16 = 2;

pub const FLAG_ERROR: u16 = 0x0001;
pub const FLAG_CONTINUED: u16 = 0x0002;
pub const FLAG_COMPRESSED: u16 = 0x0004;

pub const MAX_VALUES: usize = 4096;
pub const MAX_VERSION_LEN: usize = 64;
pub const MAX_PAYLOAD: usize = 16_777_216;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    InvalidArgument,
    LimitExceeded,
    BufferTooSmall,
    BadMagic,
}

impl WireError {
    pub fn code(&self) -> &'static str {
        match self {
            WireError::InvalidArgument => "WIRE_INVALID",
            WireError::LimitExceeded => "WIRE_LIMIT",
            WireError::BufferTooSmall => "WIRE_SMALL",
            WireError::BadMagic => "WIRE_MAGIC",
        }
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code())
    }
}

impl std::error::Error for WireError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub command: u16,
    pub flags: u16,
    pub sequence: u16,
    pub payload_len: usize,
}

fn valid_command(cmd: u16) -> bool {
    cmd == CMD_GET_INFO || cmd == CMD_TRANSFORM
}

fn valid_header_flags(flags: u16) -> bool {
    flags & !(FLAG_ERROR | FLAG_CONTINUED | FLAG_COMPRESSED) == 0
}

pub fn frame_size(payload_len: usize) -> Result<usize, WireError> {
    if payload_len > MAX_PAYLOAD {
        return Err(WireError::LimitExceeded);
    }
    Ok(WIRE_SIZE + payload_len)
}

pub fn transform_request_payload_size(count: usize) -> Result<usize, WireError> {
    if count > MAX_VALUES {
        return Err(WireError::LimitExceeded);
    }
    Ok(12 + count * 4)
}

pub fn transform_response_payload_size(count: usize) -> Result<usize, WireError> {
    if count > MAX_VALUES {
        return Err(WireError::LimitExceeded);
    }
    Ok(8 + count * 4)
}

pub fn encode_header(
    out: &mut [u8],
    command: u16,
    flags: u16,
    sequence: u16,
    payload_len: usize,
) -> Result<(), WireError> {
    if !valid_command(command) {
        return Err(WireError::InvalidArgument);
    }
    if !valid_header_flags(flags) {
        return Err(WireError::InvalidArgument);
    }
    if payload_len > MAX_PAYLOAD {
        return Err(WireError::LimitExceeded);
    }
    if out.len() < WIRE_SIZE {
        return Err(WireError::BufferTooSmall);
    }
    out[0..2].copy_from_slice(&WIRE_MAGIC.to_le_bytes());
    out[2..4].copy_from_slice(&command.to_le_bytes());
    out[4..6].copy_from_slice(&flags.to_le_bytes());
    out[6..8].copy_from_slice(&sequence.to_le_bytes());
    out[8..12].copy_from_slice(&(payload_len as u32).to_le_bytes());
    out[12..16].copy_from_slice(&0u32.to_le_bytes());
    Ok(())
}

pub fn decode_header(buf: &[u8]) -> Result<Header, WireError> {
    if buf.len() < WIRE_SIZE {
        return Err(WireError::BufferTooSmall);
    }
    let magic = u16::from_le_bytes([buf[0], buf[1]]);
    if magic != WIRE_MAGIC {
        return Err(WireError::BadMagic);
    }
    let command = u16::from_le_bytes([buf[2], buf[3]]);
    if !valid_command(command) {
        return Err(WireError::InvalidArgument);
    }
    let flags = u16::from_le_bytes([buf[4], buf[5]]);
    if !valid_header_flags(flags) {
        return Err(WireError::InvalidArgument);
    }
    let sequence = u16::from_le_bytes([buf[6], buf[7]]);
    let payload_len = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]) as usize;
    if payload_len > MAX_PAYLOAD {
        return Err(WireError::LimitExceeded);
    }
    let reserved = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    if reserved != 0 {
        return Err(WireError::InvalidArgument);
    }
    Ok(Header {
        command,
        flags,
        sequence,
        payload_len,
    })
}

/// バッチ受信の1フレーム走査。成功時は (header, payload範囲, frame長)。
/// payload は入力 slice 内のゼロコピー借用。
pub fn next_frame(buf: &[u8]) -> Result<(Header, &[u8], usize), WireError> {
    let h = decode_header(buf)?;
    let frame_len = frame_size(h.payload_len)?;
    if buf.len() < frame_len {
        return Err(WireError::BufferTooSmall);
    }
    Ok((h, &buf[WIRE_SIZE..frame_len], frame_len))
}

fn read_i32le(bytes: &[u8]) -> i32 {
    i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

pub fn encode_transform_request(
    out: &mut [u8],
    sequence: u16,
    flags: u16,
    values: &[i32],
    multiplier: i32,
    offset: i32,
) -> Result<usize, WireError> {
    if values.len() > MAX_VALUES {
        return Err(WireError::LimitExceeded);
    }
    if flags & FLAG_ERROR != 0 || flags & FLAG_COMPRESSED != 0 {
        return Err(WireError::InvalidArgument);
    }
    if flags & !(FLAG_CONTINUED) != 0 {
        return Err(WireError::InvalidArgument);
    }
    let payload_len = transform_request_payload_size(values.len())?;
    let frame_len = frame_size(payload_len)?;
    if out.len() < frame_len {
        return Err(WireError::BufferTooSmall);
    }
    encode_header(out, CMD_TRANSFORM, flags, sequence, payload_len)?;
    let p = &mut out[WIRE_SIZE..frame_len];
    p[0..4].copy_from_slice(&(values.len() as u32).to_le_bytes());
    p[4..8].copy_from_slice(&(multiplier as u32).to_le_bytes());
    p[8..12].copy_from_slice(&(offset as u32).to_le_bytes());
    for (i, v) in values.iter().enumerate() {
        p[12 + i * 4..16 + i * 4].copy_from_slice(&(*v as u32).to_le_bytes());
    }
    Ok(frame_len)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedTransformRequest<'a> {
    pub sequence: u16,
    pub count: usize,
    pub multiplier: i32,
    pub offset: i32,
    /// LE i32 列の生バイト。`value(i)` で読む (入力buf内の借用)。
    pub values_bytes: &'a [u8],
}

impl<'a> DecodedTransformRequest<'a> {
    pub fn value(&self, i: usize) -> Option<i32> {
        if i >= self.count {
            return None;
        }
        let o = i * 4;
        Some(read_i32le(&self.values_bytes[o..o + 4]))
    }

    pub fn to_vec(&self) -> Vec<i32> {
        (0..self.count).map(|i| self.value(i).unwrap_or(0)).collect()
    }
}

pub fn decode_transform_request(frame: &[u8]) -> Result<DecodedTransformRequest<'_>, WireError> {
    let (h, payload, frame_len) = next_frame(frame)?;
    if frame_len != frame.len() {
        return Err(WireError::InvalidArgument);
    }
    if h.command != CMD_TRANSFORM {
        return Err(WireError::InvalidArgument);
    }
    if h.flags & FLAG_ERROR != 0 || h.flags & FLAG_COMPRESSED != 0 {
        return Err(WireError::InvalidArgument);
    }
    if payload.len() < 12 || (payload.len() - 12) % 4 != 0 {
        return Err(WireError::InvalidArgument);
    }
    let count = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    if count > MAX_VALUES {
        return Err(WireError::LimitExceeded);
    }
    if payload.len() != 12 + count * 4 {
        return Err(WireError::InvalidArgument);
    }
    Ok(DecodedTransformRequest {
        sequence: h.sequence,
        count,
        multiplier: read_i32le(&payload[4..8]),
        offset: read_i32le(&payload[8..12]),
        values_bytes: &payload[12..],
    })
}

pub fn encode_transform_response(
    out: &mut [u8],
    sequence: u16,
    flags: u16,
    values: &[i32],
    checksum: u32,
) -> Result<usize, WireError> {
    if values.len() > MAX_VALUES {
        return Err(WireError::LimitExceeded);
    }
    if flags & FLAG_COMPRESSED != 0 {
        return Err(WireError::InvalidArgument);
    }
    if flags & !(FLAG_ERROR | FLAG_CONTINUED) != 0 {
        return Err(WireError::InvalidArgument);
    }
    let payload_len = transform_response_payload_size(values.len())?;
    let frame_len = frame_size(payload_len)?;
    if out.len() < frame_len {
        return Err(WireError::BufferTooSmall);
    }
    encode_header(out, CMD_TRANSFORM, flags, sequence, payload_len)?;
    let p = &mut out[WIRE_SIZE..frame_len];
    p[0..4].copy_from_slice(&(values.len() as u32).to_le_bytes());
    p[4..8].copy_from_slice(&checksum.to_le_bytes());
    for (i, v) in values.iter().enumerate() {
        p[8 + i * 4..12 + i * 4].copy_from_slice(&(*v as u32).to_le_bytes());
    }
    Ok(frame_len)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedTransformResponse<'a> {
    pub sequence: u16,
    pub flags: u16,
    pub count: usize,
    pub checksum: u32,
    pub values_bytes: &'a [u8],
}

impl<'a> DecodedTransformResponse<'a> {
    pub fn value(&self, i: usize) -> Option<i32> {
        if i >= self.count {
            return None;
        }
        let o = i * 4;
        Some(read_i32le(&self.values_bytes[o..o + 4]))
    }

    pub fn to_vec(&self) -> Vec<i32> {
        (0..self.count).map(|i| self.value(i).unwrap_or(0)).collect()
    }
}

pub fn decode_transform_response(
    frame: &[u8],
) -> Result<DecodedTransformResponse<'_>, WireError> {
    let (h, payload, frame_len) = next_frame(frame)?;
    if frame_len != frame.len() {
        return Err(WireError::InvalidArgument);
    }
    if h.command != CMD_TRANSFORM {
        return Err(WireError::InvalidArgument);
    }
    if h.flags & FLAG_COMPRESSED != 0 {
        return Err(WireError::InvalidArgument);
    }
    if payload.len() < 8 || (payload.len() - 8) % 4 != 0 {
        return Err(WireError::InvalidArgument);
    }
    let count = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    if count > MAX_VALUES {
        return Err(WireError::LimitExceeded);
    }
    if payload.len() != 8 + count * 4 {
        return Err(WireError::InvalidArgument);
    }
    Ok(DecodedTransformResponse {
        sequence: h.sequence,
        flags: h.flags,
        count,
        checksum: u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]),
        values_bytes: &payload[8..],
    })
}

pub fn encode_get_info_request(out: &mut [u8], sequence: u16) -> Result<usize, WireError> {
    if out.len() < WIRE_SIZE {
        return Err(WireError::BufferTooSmall);
    }
    encode_header(out, CMD_GET_INFO, 0, sequence, 0)?;
    Ok(WIRE_SIZE)
}

pub fn encode_get_info_response(
    out: &mut [u8],
    sequence: u16,
    abi_version: u32,
    version: &[u8],
) -> Result<usize, WireError> {
    if version.is_empty() || version.len() > MAX_VERSION_LEN {
        return Err(WireError::InvalidArgument);
    }
    if version.contains(&0) {
        return Err(WireError::InvalidArgument);
    }
    let payload_len = 8 + version.len();
    let frame_len = frame_size(payload_len)?;
    if out.len() < frame_len {
        return Err(WireError::BufferTooSmall);
    }
    encode_header(out, CMD_GET_INFO, 0, sequence, payload_len)?;
    let p = &mut out[WIRE_SIZE..frame_len];
    p[0..4].copy_from_slice(&abi_version.to_le_bytes());
    p[4..8].copy_from_slice(&(version.len() as u32).to_le_bytes());
    p[8..].copy_from_slice(version);
    Ok(frame_len)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedGetInfoResponse<'a> {
    pub sequence: u16,
    pub abi_version: u32,
    pub version_bytes: &'a [u8],
}

pub fn decode_get_info_response(frame: &[u8]) -> Result<DecodedGetInfoResponse<'_>, WireError> {
    let (h, payload, frame_len) = next_frame(frame)?;
    if frame_len != frame.len() {
        return Err(WireError::InvalidArgument);
    }
    if h.command != CMD_GET_INFO {
        return Err(WireError::InvalidArgument);
    }
    if h.flags & FLAG_ERROR != 0 {
        return Err(WireError::InvalidArgument);
    }
    if payload.len() < 8 {
        return Err(WireError::InvalidArgument);
    }
    let abi = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let vlen = u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]) as usize;
    if vlen == 0 || vlen > MAX_VERSION_LEN {
        return Err(WireError::InvalidArgument);
    }
    if payload.len() != 8 + vlen {
        return Err(WireError::InvalidArgument);
    }
    let vb = &payload[8..];
    if vb.contains(&0) {
        return Err(WireError::InvalidArgument);
    }
    Ok(DecodedGetInfoResponse {
        sequence: h.sequence,
        abi_version: abi,
        version_bytes: vb,
    })
}

/// 共有リングバッファのレイアウト (`core_wire.h` の CORE_RING_* と同一)。
/// offset 0: head u32、offset 4: tail u32、offset 8: capacity u32、
/// offset 12 以降が data[capacity]。空は head==tail で、1バイト空けて満杯判定する。
pub const RING_META_SIZE: usize = 12;
pub const RING_OFF_HEAD: usize = 0;
pub const RING_OFF_TAIL: usize = 4;
pub const RING_OFF_CAPACITY: usize = 8;

/// head/tail/capacity の組合せ検査。head/tail は capacity 未満でなければならない。
pub fn ring_check(head: u32, tail: u32, capacity: u32) -> Result<(), WireError> {
    if capacity == 0 {
        return Err(WireError::InvalidArgument);
    }
    if head >= capacity || tail >= capacity {
        return Err(WireError::InvalidArgument);
    }
    Ok(())
}

pub fn ring_used(head: u32, tail: u32, capacity: u32) -> u32 {
    if capacity == 0 {
        return 0;
    }
    if head >= tail {
        head - tail
    } else {
        capacity - (tail - head)
    }
}

pub fn ring_free(head: u32, tail: u32, capacity: u32) -> u32 {
    if capacity == 0 {
        return 0;
    }
    capacity - 1 - ring_used(head, tail, capacity)
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn header_round_trip_bytes() {
        let mut buf = [0u8; 16];
        encode_header(&mut buf, CMD_TRANSFORM, 0, 7, 12).unwrap();
        // magic LE bytes [0x42, 0x57], cmd=2, flags=0, seq=7, len=12, reserved=0
        assert_eq!(
            buf,
            [0x42, 0x57, 0x02, 0x00, 0x00, 0x00, 0x07, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        );
        let h = decode_header(&buf).unwrap();
        assert_eq!(h.command, CMD_TRANSFORM);
        assert_eq!(h.sequence, 7);
        assert_eq!(h.payload_len, 12);
    }

    #[test]
    fn bad_magic_rejected() {
        let mut buf = [0u8; 16];
        encode_header(&mut buf, CMD_GET_INFO, 0, 1, 0).unwrap();
        buf[0] ^= 0xff;
        assert_eq!(decode_header(&buf), Err(WireError::BadMagic));
    }

    #[test]
    fn transform_basic_round_trip() {
        let mut buf = [0u8; 64];
        let n = encode_transform_request(&mut buf, 9, 0, &[1, 2, 3], 2, 1).unwrap();
        assert_eq!(n, 16 + 12 + 12);
        let d = decode_transform_request(&buf[..n]).unwrap();
        assert_eq!((d.sequence, d.count, d.multiplier, d.offset), (9, 3, 2, 1));
        assert_eq!(d.to_vec(), vec![1, 2, 3]);
    }

    #[test]
    fn transform_empty_round_trip() {
        let mut buf = [0u8; 32];
        let n = encode_transform_request(&mut buf, 1, 0, &[], 1, 0).unwrap();
        assert_eq!(n, 28);
        let d = decode_transform_request(&buf[..n]).unwrap();
        assert_eq!(d.count, 0);
        assert_eq!(d.to_vec(), Vec::<i32>::new());
    }

    #[test]
    fn transform_response_round_trip() {
        let mut buf = [0u8; 64];
        let n = encode_transform_response(&mut buf, 4, 0, &[3, 5, 7], 15).unwrap();
        assert_eq!(n, 16 + 8 + 12);
        let d = decode_transform_response(&buf[..n]).unwrap();
        assert_eq!((d.sequence, d.count, d.checksum), (4, 3, 15));
        assert_eq!(d.to_vec(), vec![3, 5, 7]);
    }

    #[test]
    fn too_long_is_limit() {
        let big = vec![1i32; 4097];
        let mut buf = vec![0u8; 32];
        assert_eq!(
            encode_transform_request(&mut buf, 1, 0, &big, 1, 0),
            Err(WireError::LimitExceeded)
        );
    }

    #[test]
    fn get_info_round_trip() {
        let mut q = [0u8; 16];
        assert_eq!(encode_get_info_request(&mut q, 3).unwrap(), 16);
        let mut r = [0u8; 32];
        let n = encode_get_info_response(&mut r, 3, 1, b"0.1.0").unwrap();
        assert_eq!(n, 16 + 8 + 5);
        let d = decode_get_info_response(&r[..n]).unwrap();
        assert_eq!(d.abi_version, 1);
        assert_eq!(d.version_bytes, b"0.1.0");
    }

    #[test]
    fn batch_scan_two_frames() {
        let mut buf = [0u8; 128];
        let n1 = encode_transform_request(&mut buf, 1, 0, &[1], 1, 0).unwrap();
        let n2 = encode_transform_request(&mut buf[n1..], 2, 0, &[2, 3], 1, 0).unwrap();
        let total = n1 + n2;
        let (h1, _, f1) = next_frame(&buf[..total]).unwrap();
        assert_eq!((h1.sequence, f1), (1, n1));
        let (h2, _, f2) = next_frame(&buf[n1..total]).unwrap();
        assert_eq!((h2.sequence, f2), (2, n2));
    }

    #[test]
    fn ring_used_free_layout() {
        assert_eq!(ring_used(0, 0, 64), 0);
        assert_eq!(ring_free(0, 0, 64), 63);
        assert_eq!(ring_used(10, 4, 64), 6);
        // ラップ時: head=2, tail=60, cap=64 -> used=6
        assert_eq!(ring_used(2, 60, 64), 6);
        assert_eq!(ring_free(2, 60, 64), 57);
        assert!(ring_check(0, 0, 64).is_ok());
        assert_eq!(ring_check(64, 0, 64), Err(WireError::InvalidArgument));
        assert_eq!(ring_check(0, 0, 0), Err(WireError::InvalidArgument));
    }
}
