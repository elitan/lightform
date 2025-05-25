package models

// CertConfig holds certificate configuration options
type CertConfig struct {
	// Email address for Let's Encrypt registration
	Email string `json:"email"`
}

// NewDefaultCertConfig returns a CertConfig with default values
func NewDefaultCertConfig() CertConfig {
	return CertConfig{
		// CertDir and RenewBefore will use hardcoded defaults in the cert manager
	}
}
