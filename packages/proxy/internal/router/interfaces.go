package router

import "crypto/tls"

// CertificateProvider is the interface that the router needs from cert management
type CertificateProvider interface {
	GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error)
	ServeHTTPChallenge(token string) (string, bool)
}