package cert

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"sync"
	"time"
)

const retryQueueFile = "/tmp/luma-proxy-cert-queue.json"

// RetryEntry represents a domain waiting for certificate provisioning
type RetryEntry struct {
	Domain   string    `json:"domain"`
	FirstTry time.Time `json:"first_try"`
	NextTry  time.Time `json:"next_try"`
	Attempts int       `json:"attempts"`
}

// QueueEntry represents a domain waiting for certificate provisioning (legacy compatibility)
type QueueEntry struct {
	Hostname    string    `json:"hostname"`
	Email       string    `json:"email"`
	AddedAt     time.Time `json:"added_at"`
	LastAttempt time.Time `json:"last_attempt"`
	Attempts    int       `json:"attempts"`
}

// RetryQueue manages domains that need certificate provisioning
type RetryQueue struct {
	entries map[string]*RetryEntry
	mutex   sync.RWMutex
}

// NewRetryQueue creates a new retry queue
func NewRetryQueue() *RetryQueue {
	queue := &RetryQueue{
		entries: make(map[string]*RetryEntry),
	}
	queue.Load()
	return queue
}

// Add adds a domain to the retry queue
func (q *RetryQueue) Add(entry RetryEntry) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	q.entries[entry.Domain] = &entry
	return q.save()
}

// Get gets a retry entry for a domain
func (q *RetryQueue) Get(domain string) *RetryEntry {
	q.mutex.RLock()
	defer q.mutex.RUnlock()

	if entry, exists := q.entries[domain]; exists {
		return entry
	}
	return nil
}

// Remove removes a domain from the retry queue
func (q *RetryQueue) Remove(domain string) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	delete(q.entries, domain)
	return q.save()
}

// UpdateAttempt updates the attempt count and schedules next retry
func (q *RetryQueue) UpdateAttempt(domain string) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	if entry, exists := q.entries[domain]; exists {
		entry.Attempts++

		// Check if we've exceeded max attempts (3 days = 3*24*60/5 = 864 attempts)
		maxAttempts := 864 // 3 days of 5-minute retries
		if entry.Attempts >= maxAttempts {
			log.Printf("Max attempts reached for %s, removing from queue", domain)
			delete(q.entries, domain)
		} else {
			// Schedule next retry in 5 minutes
			entry.NextTry = time.Now().Add(5 * time.Minute)
		}

		return q.save()
	}

	return fmt.Errorf("domain %s not found in queue", domain)
}

// GetReadyEntries returns domains that are ready for retry
func (q *RetryQueue) GetReadyEntries() []RetryEntry {
	q.mutex.RLock()
	defer q.mutex.RUnlock()

	var ready []RetryEntry
	now := time.Now()

	for _, entry := range q.entries {
		// Check if it's time for the next retry
		if now.After(entry.NextTry) || now.Equal(entry.NextTry) {
			ready = append(ready, *entry)
		}
	}

	return ready
}

// List returns all entries in the queue (for status/debugging)
func (q *RetryQueue) List() []*QueueEntry {
	q.mutex.RLock()
	defer q.mutex.RUnlock()

	var entries []*QueueEntry
	for _, entry := range q.entries {
		// Convert RetryEntry to QueueEntry for compatibility
		queueEntry := &QueueEntry{
			Hostname:    entry.Domain,
			Email:       "", // Not stored in new format
			AddedAt:     entry.FirstTry,
			LastAttempt: time.Now(), // Approximate
			Attempts:    entry.Attempts,
		}
		entries = append(entries, queueEntry)
	}

	return entries
}

// Size returns the number of entries in the queue
func (q *RetryQueue) Size() int {
	q.mutex.RLock()
	defer q.mutex.RUnlock()
	return len(q.entries)
}

// Load loads the retry queue from disk
func (q *RetryQueue) Load() error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	// Check if file exists
	if _, err := os.Stat(retryQueueFile); os.IsNotExist(err) {
		// File doesn't exist, start with empty queue
		return nil
	}

	// Read the file
	data, err := ioutil.ReadFile(retryQueueFile)
	if err != nil {
		log.Printf("Warning: Failed to read certificate retry queue: %v", err)
		return err
	}

	// Try to parse as new format first
	var newEntries []RetryEntry
	if err := json.Unmarshal(data, &newEntries); err == nil {
		// New format - convert to map
		q.entries = make(map[string]*RetryEntry)
		for _, entry := range newEntries {
			q.entries[entry.Domain] = &entry
		}
		log.Printf("Loaded %d domains from retry queue (new format)", len(q.entries))
		return nil
	}

	// Try to parse as legacy format
	var legacyEntries []*QueueEntry
	if err := json.Unmarshal(data, &legacyEntries); err != nil {
		log.Printf("Warning: Failed to parse certificate retry queue: %v", err)
		return err
	}

	// Convert legacy format to new format
	q.entries = make(map[string]*RetryEntry)
	for _, legacy := range legacyEntries {
		entry := &RetryEntry{
			Domain:   legacy.Hostname,
			FirstTry: legacy.AddedAt,
			NextTry:  time.Now().Add(5 * time.Minute), // Schedule immediate retry
			Attempts: legacy.Attempts,
		}
		q.entries[entry.Domain] = entry
	}

	log.Printf("Loaded %d domains from retry queue (legacy format converted)", len(q.entries))
	return nil
}

// save saves the retry queue to disk
func (q *RetryQueue) save() error {
	// Convert map to slice for JSON serialization
	var entries []RetryEntry
	for _, entry := range q.entries {
		entries = append(entries, *entry)
	}

	// Marshal to JSON
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal retry queue: %w", err)
	}

	// Write to file
	if err := ioutil.WriteFile(retryQueueFile, data, 0644); err != nil {
		return fmt.Errorf("failed to write retry queue: %w", err)
	}

	return nil
}
