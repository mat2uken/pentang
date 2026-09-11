//! `pocbin:` custom schemeによるバイナリデータプレーン。
//! `fetch("pocbin://localhost/transform", { method: "POST", body: bytes })` で
//! wire要求batchの生バイトを送ると、wire応答batchの生バイトが返る。
//! invoke(JSON/base64)のテキスト変換を完全に避ける最速経路。
//! 検証・計算は `crate::batch::process_batch` に一本化し、二重実装しない。
//!
//! Android WebViewはPOST bodyを配送しない (shouldInterceptRequestの仕様) ため、
//! 同環境では `GET /transform?data=<base64url>` を使う。応答は同じ生バイト。
//! (WRYのhttp迂回 `http://pocbin.localhost/...` 経由で到達する。)
//!
//! エラーは成功時と分ける: 成功=200+octet-stream、失敗=4xx/5xx+JSON AppError
//! (制御的な稀少経路のみテキスト)。CORS preflight (OPTIONS) にも応答する。

use std::borrow::Cow;

use tauri::http::{
    header::{ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
             ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_MAX_AGE, CONTENT_TYPE},
    Method, Request, Response, StatusCode,
};

use crate::commands::AppErrorDto;

const OCTET_STREAM: &str = "application/octet-stream";
const JSON_TYPE: &str = "application/json";

const EMPTY: &[u8] = &[];

fn fallback_response() -> Response<Cow<'static, [u8]>> {
    Response::new(Cow::Borrowed(EMPTY))
}

fn cors(res: &mut Response<Cow<'static, [u8]>>) {
    res.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_ORIGIN,
        tauri::http::header::HeaderValue::from_static("*"),
    );
}

fn ok_bytes(body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    let mut res = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, OCTET_STREAM)
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| fallback_response());
    cors(&mut res);
    res
}

fn err_json(status: StatusCode, err: &AppErrorDto) -> Response<Cow<'static, [u8]>> {
    let body = serde_json::to_vec(err).unwrap_or_else(|_| b"{}".to_vec());
    let mut res = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, JSON_TYPE)
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| fallback_response());
    cors(&mut res);
    res
}

/// GETクエリから `data` パラメータを抜く。base64url文字のみ受け付ける。
fn query_data(uri: &tauri::http::Uri) -> Option<&str> {
    let q = uri.query()?;
    for pair in q.split('&') {
        if let Some(rest) = pair.strip_prefix("data=") {
            if rest.is_empty()
                || !rest
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return None;
            }
            return Some(rest);
        }
    }
    None
}

fn err_status(code: &str) -> StatusCode {
    match code {
        "INVALID_ARGUMENT" => StatusCode::BAD_REQUEST,
        "LIMIT_EXCEEDED" => StatusCode::PAYLOAD_TOO_LARGE,
        "OUT_OF_MEMORY" => StatusCode::INSUFFICIENT_STORAGE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn options_reply() -> Response<Cow<'static, [u8]>> {
    let mut res = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
        .header(ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(ACCESS_CONTROL_MAX_AGE, "86400")
        .body(Cow::Borrowed(EMPTY))
        .unwrap_or_else(|_| fallback_response());
    cors(&mut res);
    res
}

/// pocbin schemeハンドラ。同期でよい (計算は数十μs級でblockしない)。
pub fn handle_pocbin(req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if req.method() == Method::OPTIONS {
        return options_reply();
    }
    match (req.method(), req.uri().path()) {
        (&Method::GET, "/health") => {
            let mut res = Response::new(Cow::Borrowed(EMPTY));
            cors(&mut res);
            res
        }
        (&Method::POST, "/transform") => match crate::batch::process_batch(req.body()) {
            Ok(out) => ok_bytes(out),
            Err(e) => {
                let status = err_status(&e.code);
                err_json(status, &e)
            }
        },
        // Android WebViewはPOST bodyを配送しないためGETクエリで運ぶ。
        (&Method::GET, "/transform") => match query_data(req.uri()) {
            Some(b64) => {
                use base64::Engine as _;
                match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b64) {
                    Ok(bytes) => match crate::batch::process_batch(&bytes) {
                        Ok(out) => ok_bytes(out),
                        Err(e) => {
                            let status = err_status(&e.code);
                            err_json(status, &e)
                        }
                    },
                    Err(_) => err_json(
                        StatusCode::BAD_REQUEST,
                        &AppErrorDto::new("INVALID_ARGUMENT", "data must be base64url".to_string()),
                    ),
                }
            }
            None => err_json(
                StatusCode::BAD_REQUEST,
                &AppErrorDto::new("INVALID_ARGUMENT", "missing data query".to_string()),
            ),
        },
        _ => err_json(
            StatusCode::NOT_FOUND,
            &AppErrorDto::new("INVALID_ARGUMENT", "unknown pocbin route".to_string()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use poc_core_ffi::wire;

    fn basic_batch() -> Vec<u8> {
        let mut buf = vec![0u8; 64];
        let n =
            wire::encode_transform_request(&mut buf, 3, 0, &[1, 2, 3], 2, 1).expect("enc");
        buf.truncate(n);
        buf
    }

    fn post_transform(body: Vec<u8>) -> Request<Vec<u8>> {
        Request::builder()
            .method(Method::POST)
            .uri("pocbin://localhost/transform")
            .body(body)
            .expect("req")
    }

    #[test]
    fn get_transform_query_round_trip() {
        use base64::Engine as _;
        let body = basic_batch();
        let q = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&body);
        let req = Request::builder()
            .method(Method::GET)
            .uri(format!("pocbin://localhost/transform?data={q}"))
            .body(Vec::new())
            .expect("req");
        let res = handle_pocbin(req);
        assert_eq!(res.status(), StatusCode::OK);
        let d = wire::decode_transform_response(res.body()).expect("dec");
        assert_eq!(d.to_vec(), vec![3, 5, 7]);
    }

    #[test]
    fn get_transform_query_rejected() {
        for uri in [
            "pocbin://localhost/transform",
            "pocbin://localhost/transform?data=",
            "pocbin://localhost/transform?data=!!nope!!",
            "pocbin://localhost/transform?other=abc",
        ] {
            let req = Request::builder()
                .method(Method::GET)
                .uri(uri)
                .body(Vec::new())
                .expect("req");
            assert_eq!(
                handle_pocbin(req).status(),
                StatusCode::BAD_REQUEST,
                "uri={uri}"
            );
        }
    }

    #[test]
    fn transform_round_trip() {
        let res = handle_pocbin(post_transform(basic_batch()));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()[CONTENT_TYPE],
            OCTET_STREAM,
            "binary content type"
        );
        let d = wire::decode_transform_response(res.body()).expect("dec");
        assert_eq!(d.sequence, 3);
        assert_eq!(d.to_vec(), vec![3, 5, 7]);
        assert_eq!(d.checksum, 15);
    }

    #[test]
    fn invalid_body_maps_to_400_json() {
        let res = handle_pocbin(post_transform(b"garbage".to_vec()));
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let v: serde_json::Value = serde_json::from_slice(res.body()).expect("json");
        assert_eq!(v["code"], "INVALID_ARGUMENT");
    }

    #[test]
    fn health_and_options_and_unknown_routes() {
        let health = Request::builder()
            .method(Method::GET)
            .uri("pocbin://localhost/health")
            .body(Vec::new())
            .expect("req");
        let res = handle_pocbin(health);
        assert_eq!(res.status(), StatusCode::OK);

        let opts = Request::builder()
            .method(Method::OPTIONS)
            .uri("pocbin://localhost/transform")
            .body(Vec::new())
            .expect("req");
        let res = handle_pocbin(opts);
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(res.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN));

        let unknown = Request::builder()
            .method(Method::GET)
            .uri("pocbin://localhost/nope")
            .body(Vec::new())
            .expect("req");
        assert_eq!(handle_pocbin(unknown).status(), StatusCode::NOT_FOUND);
    }
}
