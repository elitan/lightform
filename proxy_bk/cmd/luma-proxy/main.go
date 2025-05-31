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
	case "list":
		listCmd := cmd.NewListCmd()
		if err = listCmd.Parse(os.Args[2:]); err != nil {
			log.Fatalf("Failed to parse list command arguments: %v", err)
		}
		err = listCmd.Execute()
	case "updatehealth":
		updateHealthCmd := cmd.NewUpdateHealthCmd()
		if err = updateHealthCmd.Parse(os.Args[2:]); err != nil {
			log.Fatalf("Failed to parse updatehealth command arguments: %v", err)
		}
		err = updateHealthCmd.Execute()
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
	fmt.Println("  deploy --host <hostname> --target <ip:port> [--project <project-name>] [--health-path <path>]")
	fmt.Println("      Configure routing for a hostname")
	fmt.Println("  status [--domain <domain>]")
	fmt.Println("      Check certificate retry queue status and domain information")
	fmt.Println("  list")
	fmt.Println("      List the current routes configured in the proxy")
	fmt.Println("  updatehealth")
	fmt.Println("      Update the health status of a service")
	fmt.Println("        --host <hostname>       Hostname to update")
	fmt.Println("        --healthy <true/false>  Health status")
	fmt.Println("\nLet's Encrypt certificate options for 'run' command:")
	fmt.Println("  --cert-email <email>   Email address for Let's Encrypt registration (recommended)")
	fmt.Println("\nDeploy command options:")
	fmt.Println("  --health-path <path>   Health check endpoint path (default: /up)")
	fmt.Println("\nStatus command options:")
	fmt.Println("  --domain <domain>      Check certificate status for specific domain")
	fmt.Println("\nUse 'luma-proxy <command> --help' for more information on a specific command.")
}
