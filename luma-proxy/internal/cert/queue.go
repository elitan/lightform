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

// QueueEntry represents a domain waiting for certificate provisioning
type QueueEntry struct {
	Hostname    string    `json:"hostname"`
	Email       string    `json:"email"`
	AddedAt     time.Time `json:"added_at"`
	LastAttempt time.Time `json:"last_attempt"`
	Attempts    int       `json:"attempts"`
}

// RetryQueue manages domains that need certificate provisioning
type RetryQueue struct {
	entries map[string]*QueueEntry
	mutex   sync.RWMutex
}

// NewRetryQueue creates a new retry queue
func NewRetryQueue() *RetryQueue {
	queue := &RetryQueue{
		entries: make(map[string]*QueueEntry),
	}
	queue.Load()
	return queue
}

// Add adds a domain to the retry queue
func (q *RetryQueue) Add(hostname, email string) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	q.entries[hostname] = &QueueEntry{
		Hostname:    hostname,
		Email:       email,
		AddedAt:     time.Now(),
		LastAttempt: time.Time{}, // Never attempted
		Attempts:    0,
	}

	return q.save()
}

// Remove removes a domain from the retry queue
func (q *RetryQueue) Remove(hostname string) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	delete(q.entries, hostname)
	return q.save()
}

// UpdateAttempt updates the attempt count and timestamp for a domain
func (q *RetryQueue) UpdateAttempt(hostname string) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	if entry, exists := q.entries[hostname]; exists {
		entry.LastAttempt = time.Now()
		entry.Attempts++
		return q.save()
	}

	return fmt.Errorf("hostname %s not found in queue", hostname)
}

// GetPendingEntries returns domains that are ready for retry
func (q *RetryQueue) GetPendingEntries() []*QueueEntry {
	q.mutex.RLock()
	defer q.mutex.RUnlock()

	var pending []*QueueEntry
	now := time.Now()

	for _, entry := range q.entries {
		// Skip if attempted recently (wait at least 5 minutes between attempts)
		if !entry.LastAttempt.IsZero() && now.Sub(entry.LastAttempt) < 5*time.Minute {
			continue
		}

		// Skip if too many attempts (max 24 attempts = 2 hours of retries)
		if entry.Attempts >= 24 {
			log.Printf("Max attempts reached for %s, removing from queue", entry.Hostname)
			delete(q.entries, entry.Hostname)
			continue
		}

		pending = append(pending, entry)
	}

	// Save if we removed any entries
	if len(pending) < len(q.entries) {
		q.save()
	}

	return pending
}

// List returns all entries in the queue
func (q *RetryQueue) List() []*QueueEntry {
	q.mutex.RLock()
	defer q.mutex.RUnlock()

	var entries []*QueueEntry
	for _, entry := range q.entries {
		entries = append(entries, entry)
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

	// Parse JSON
	var entries []*QueueEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		log.Printf("Warning: Failed to parse certificate retry queue: %v", err)
		return err
	}

	// Convert to map
	q.entries = make(map[string]*QueueEntry)
	for _, entry := range entries {
		q.entries[entry.Hostname] = entry
	}

	log.Printf("Loaded %d domains from certificate retry queue", len(q.entries))
	return nil
}

// save saves the retry queue to disk
func (q *RetryQueue) save() error {
	// Convert map to slice for JSON serialization
	var entries []*QueueEntry
	for _, entry := range q.entries {
		entries = append(entries, entry)
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
