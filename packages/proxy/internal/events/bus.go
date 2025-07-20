package events

import (
	"sync"

	"github.com/elitan/iop/proxy/internal/core"
)

// SimpleBus is a simple in-memory event bus
type SimpleBus struct {
	mu          sync.RWMutex
	subscribers []chan core.Event
}

// NewSimpleBus creates a new simple event bus
func NewSimpleBus() *SimpleBus {
	return &SimpleBus{
		subscribers: make([]chan core.Event, 0),
	}
}

// Publish publishes an event to all subscribers
func (b *SimpleBus) Publish(event core.Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, ch := range b.subscribers {
		select {
		case ch <- event:
			// Event sent successfully
		default:
			// Channel is full, skip this subscriber
			// In production, you might want to log this
		}
	}
}

// Subscribe creates a new subscription channel
func (b *SimpleBus) Subscribe() <-chan core.Event {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan core.Event, 100) // Buffered channel
	b.subscribers = append(b.subscribers, ch)
	return ch
}

// Unsubscribe removes a subscription channel
func (b *SimpleBus) Unsubscribe(ch <-chan core.Event) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for i, sub := range b.subscribers {
		if sub == ch {
			// Remove from slice
			b.subscribers = append(b.subscribers[:i], b.subscribers[i+1:]...)
			close(sub)
			break
		}
	}
}