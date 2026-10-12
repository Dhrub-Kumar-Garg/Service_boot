# Local HTTPS test fixture

The PEM files are a public, disposable test certificate and its unencrypted test key. They are used only by the loopback HTTPS server in engine-readiness.test.js and must never be used for a deployed service.

The certificate is self-signed for IP 127.0.0.1. The test first confirms that the normal client rejects it, then injects this certificate as a trusted CA only for the test's HTTPS requests. Production certificate verification is unchanged.

Generated with Git's bundled OpenSSL on 2026-10-12:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout localhost-key.pem -out localhost-cert.pem -days 3650 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1'
```

OpenSSL is not needed to run the tests; both fixture files are checked in.
