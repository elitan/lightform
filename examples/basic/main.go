package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func helloHandler(w http.ResponseWriter, r *http.Request) {
	exampleVar := os.Getenv("EXAMPLE_VAR")
	exampleVarB := os.Getenv("EXAMPLE_VAR_B")
	secretVar := os.Getenv("SECRET_VAR")
	secretVarB := os.Getenv("SECRET_VAR_B")
	fmt.Fprintf(w, "Hello World 5\nEXAMPLE_VAR=%s\nEXAMPLE_VAR_B=%s\nSECRET_VAR=%s\nSECRET_VAR_B=%s", exampleVar, exampleVarB, secretVar, secretVarB)
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
