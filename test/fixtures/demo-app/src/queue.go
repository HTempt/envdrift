package main

import "os"

func loadQueue() string {
	return os.Getenv("QUEUE_REDIS_URL")
}
