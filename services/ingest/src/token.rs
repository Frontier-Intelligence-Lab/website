//! Signed tokens shared with the web service (src/lib/tokens.js):
//! `base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, encoded payload))`.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hmac::{Hmac, Mac};
use serde::{Serialize, de::DeserializeOwned};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

fn mac(secret: &[u8], body: &str) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    m.update(body.as_bytes());
    m.finalize().into_bytes().to_vec()
}

pub fn sign<T: Serialize>(secret: &[u8], payload: &T) -> String {
    let body = B64.encode(serde_json::to_vec(payload).expect("payload serializes"));
    let sig = B64.encode(mac(secret, &body));
    format!("{body}.{sig}")
}

/// Returns the payload only when the MAC matches, `kind` is the expected one and `exp` (unix seconds) is in the future.
pub fn verify<T: DeserializeOwned>(
    secret: &[u8],
    token: &str,
    kind: &str,
    now_s: u64,
) -> Option<T> {
    if token.len() > 8192 {
        return None;
    }
    let mut parts = token.split('.');
    let (body, sig) = (parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let given = B64.decode(sig).ok()?;
    if !bool::from(given.ct_eq(&mac(secret, body))) {
        return None;
    }
    let raw: serde_json::Value = serde_json::from_slice(&B64.decode(body).ok()?).ok()?;
    if raw.get("kind")?.as_str()? != kind || raw.get("exp")?.as_u64()? <= now_s {
        return None;
    }
    serde_json::from_value(raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const SECRET: &[u8] = b"test-secret-that-is-at-least-32-chars!!";
    // Produced by src/lib/tokens.js signToken() with the same secret.
    const FROM_NODE: &str = "eyJ2IjoxLCJraW5kIjoidXBsb2FkIiwid3MiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJwcm9qZWN0IjoiMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyIiwiYnkiOiIzMzMzMzMzMy0zMzMzLTQzMzMtODMzMy0zMzMzMzMzMzMzMzMiLCJtYXhCeXRlcyI6MTA0ODU3NiwiZXhwIjo0MTAyNDQ0ODAwLCJub25jZSI6Im4ifQ.zLRuRgn7Ti3J32yO69ih7iZP02IGenmLsZ6dh3XvqtQ";

    #[derive(Deserialize, Serialize)]
    struct Grant {
        kind: String,
        ws: String,
        #[serde(rename = "maxBytes")]
        max_bytes: u64,
        exp: u64,
    }

    #[test]
    fn verifies_tokens_signed_by_the_web_service() {
        let g: Grant = verify(SECRET, FROM_NODE, "upload", 1_700_000_000).expect("valid");
        assert_eq!(g.ws, "11111111-1111-4111-8111-111111111111");
        assert_eq!(g.max_bytes, 1_048_576);
    }

    #[test]
    fn rejects_tampering_wrong_kind_wrong_secret_and_expiry() {
        assert!(verify::<Grant>(SECRET, FROM_NODE, "download", 1_700_000_000).is_none());
        assert!(
            verify::<Grant>(
                b"another-secret-that-is-32-chars-long",
                FROM_NODE,
                "upload",
                1_700_000_000
            )
            .is_none()
        );
        assert!(verify::<Grant>(SECRET, FROM_NODE, "upload", 4_102_444_800).is_none());
        let (body, sig) = FROM_NODE.split_once('.').unwrap();
        let mut forged = body.to_string();
        forged.replace_range(10..11, "A");
        assert!(
            verify::<Grant>(SECRET, &format!("{forged}.{sig}"), "upload", 1_700_000_000).is_none()
        );
        assert!(
            verify::<Grant>(
                SECRET,
                &format!("{FROM_NODE}.extra"),
                "upload",
                1_700_000_000
            )
            .is_none()
        );
    }

    #[test]
    fn round_trips_its_own_tokens() {
        let g = Grant {
            kind: "upload".into(),
            ws: "w".into(),
            max_bytes: 5,
            exp: 2_000_000_000,
        };
        let t = sign(SECRET, &g);
        assert_eq!(
            verify::<Grant>(SECRET, &t, "upload", 1_900_000_000)
                .unwrap()
                .max_bytes,
            5
        );
    }
}
