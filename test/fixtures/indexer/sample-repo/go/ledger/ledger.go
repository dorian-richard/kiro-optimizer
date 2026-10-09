// Package ledger keeps account balances.
package ledger

import (
	"fmt"
	"strings"
)

// MaxEntries bounds the in-memory ledger.
const MaxEntries = 1000

// Ledger records entries per account.
type Ledger struct {
	Store
	entries map[string][]Entry
	Name    string
}

// Entry is one ledger line.
type Entry struct {
	Amount int64
}

// Recorder records entries.
type Recorder interface {
	Record(account string, e Entry) error
}

// Record appends an entry to the account.
func (l *Ledger) Record(account string, e Entry) error {
	key := strings.ToLower(account)
	l.entries[key] = append(l.entries[key], e)
	return nil
}

// NewLedger creates an empty ledger.
func NewLedger(name string) *Ledger {
	l := &Ledger{Name: name, entries: map[string][]Entry{}}
	fmt.Println("created", name)
	return l
}

func helper() {}
