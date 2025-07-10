package core

import (
	"context"
	"crypto/tls"
)

// RouteProvider provides routing information
type RouteProvider interface {
	GetRoute(hostname string) (*Route, error)
	UpdateRoute(hostname string, target string, healthy bool) error
}

// DeploymentStore manages deployment persistence
type DeploymentStore interface {
	GetDeployment(hostname string) (*Deployment, error)
	SaveDeployment(deployment *Deployment) error
	ListDeployments() ([]*Deployment, error)
	DeleteDeployment(hostname string) error
}

// HealthChecker checks container health
type HealthChecker interface {
	CheckHealth(ctx context.Context, target, healthPath string) error
}

// CertificateProvider manages TLS certificates
type CertificateProvider interface {
	GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error)
	ServeHTTPChallenge(token string) (keyAuth string, found bool)
	EnsureCertificate(hostname string) error
}

// EventBus publishes and subscribes to events
type EventBus interface {
	Publish(event Event)
	Subscribe() <-chan Event
	Unsubscribe(ch <-chan Event)
}

// DeploymentController orchestrates deployments
type DeploymentController interface {
	Deploy(ctx context.Context, hostname, target, project, app string) error
	GetStatus(hostname string) (*Deployment, error)
	Rollback(ctx context.Context, hostname string) error
}

// ProxyRouter routes HTTP requests
type ProxyRouter interface {
	ServeHTTP(w ResponseWriter, r *Request)
	UpdateRoute(hostname string, target string, healthy bool)
}

// Simplified HTTP interfaces to avoid circular dependencies
type ResponseWriter interface {
	Header() map[string][]string
	Write([]byte) (int, error)
	WriteHeader(statusCode int)
}

type Request interface {
	GetHost() string
	GetPath() string
	GetMethod() string
	GetHeader(key string) string
	SetHeader(key, value string)
	IsTLS() bool
}