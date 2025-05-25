package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func helloHandler(w http.ResponseWriter, r *http.Request) {
	exampleVar := os.Getenv("EXAMPLE_VAR")
	secretVar := os.Getenv("SECRET_VAR")
	fmt.Fprintf(w, "Hello World 5\nEXAMPLE_VAR=%s\nSECRET_VAR=%s", exampleVar, secretVar)
}

func main() {
	http.HandleFunc("/", helloHandler)

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	fmt.Printf("Starting server at port %s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
