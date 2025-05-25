package main

import (
	"fmt"
	"log"
	"os"

	"github.com/elitan/luma-proxy/internal/cmd"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	var err error

	switch os.Args[1] {
	case "run":
		runCmd := cmd.NewRunCmd()
		if err = runCmd.Parse(os.Args[2:]); err != nil {
			log.Fatalf("Failed to parse run command arguments: %v", err)
		}
		err = runCmd.Execute()
	case "deploy":
		deployCmd := cmd.NewDeployCmd()
		if err = deployCmd.Parse(os.Args[2:]); err != nil {
			log.Fatalf("Failed to parse deploy command arguments: %v", err)
		}
		err = deployCmd.Execute()
	case "status":
		statusCmd := cmd.NewStatusCmd()
		if err = statusCmd.Parse(os.Args[2:]); err != nil {
			log.Fatalf("Failed to parse status command arguments: %v", err)
		}
		err = statusCmd.Execute()
	default:
		fmt.Printf("Unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}

	if err != nil {
		log.Fatalf("Error: %v", err)
	}
}

func printUsage() {
	fmt.Println("Luma Proxy")
	fmt.Println("Usage: luma-proxy <command> [arguments]")
	fmt.Println("\nCommands:")
	fmt.Println("  run [--port <https_port>] [--socket-path <path>] [--cert-email <email>]")
	fmt.Println("      Run the proxy daemon (HTTP on 80 redirects to HTTPS, automatic Let's Encrypt)")
	fmt.Println("  deploy --host <hostname> --target <ip:port> [--project <project-name>]")
	fmt.Println("      Configure routing for a hostname")
	fmt.Println("  status")
	fmt.Println("      Check the certificate retry queue status")
	fmt.Println("\nLet's Encrypt certificate options for 'run' command:")
	fmt.Println("  --cert-email <email>   Email address for Let's Encrypt registration (recommended)")
	fmt.Println("\nUse 'luma-proxy <command> --help' for more information on a specific command.")
}
