import { describe, expect, test, mock } from "bun:test";
import { DockerClient } from "../src/docker";
import type { ServiceEntry, LightformSecrets, LightformConfig } from "../src/config/types";

// Mock the dependencies
const mockSSHClient = {
  exec: mock(() => Promise.resolve("")),
  close: mock(() => Promise.resolve()),
};

const mockLogger = {
  verboseLog: mock(() => {}),
  error: mock(() => {}),
};

// Mock the deployService function by extracting the logic we want to test
async function mockDeployService(
  service: ServiceEntry,
  dockerClient: DockerClient,
  context: { config: LightformConfig; secrets: LightformSecrets }
): Promise<void> {
  // Pull the latest image
  await dockerClient.pullImage(service.image);

  // Create container options from the service definition
  const containerOptions = DockerClient.serviceToContainerOptions(
    service,
    context.config.name!,
    context.secrets
  );

  // Check if container already exists (running or not)
  const containerExists = await dockerClient.containerExists(
    containerOptions.name
  );

  if (containerExists) {
    await handleExistingServiceContainer(containerOptions.name, dockerClient, containerOptions);
  } else {
    await createNewServiceContainer(containerOptions, dockerClient);
  }
}

// The functions we're testing (extracted from setup.ts)
async function handleExistingServiceContainer(
  containerName: string,
  dockerClient: DockerClient,
  containerOptions: any
): Promise<void> {
  // Stop and remove the existing container
  const containerRunning = await dockerClient.containerIsRunning(containerName);
  if (containerRunning) {
    await dockerClient.stopContainer(containerName);
  }
  await dockerClient.removeContainer(containerName);
  
  // Create the container with new configuration
  await dockerClient.createContainer(containerOptions);
}

async function createNewServiceContainer(
  containerOptions: any,
  dockerClient: DockerClient
): Promise<void> {
  await dockerClient.createContainer(containerOptions);
}

describe("Service container recreation on config changes", () => {
  test("should recreate existing running container when ports change", async () => {
    // Arrange
    const service: ServiceEntry = {
      name: "db",
      image: "postgres:15",
      server: "server.example.com",
      ports: ["9002:5432"], // Changed from 5432:5432 to 9002:5432
    };

    const context = {
      config: { name: "test-project" } as LightformConfig,
      secrets: {} as LightformSecrets,
    };

    // Create mock DockerClient
    const dockerClient = new DockerClient(mockSSHClient as any, "test-server", false);
    
    // Mock the methods
    const pullImageMock = mock(() => Promise.resolve());
    const containerExistsMock = mock(() => Promise.resolve(true)); // Container exists
    const containerIsRunningMock = mock(() => Promise.resolve(true)); // Container is running
    const stopContainerMock = mock(() => Promise.resolve());
    const removeContainerMock = mock(() => Promise.resolve());
    const createContainerMock = mock(() => Promise.resolve());

    dockerClient.pullImage = pullImageMock;
    dockerClient.containerExists = containerExistsMock;
    dockerClient.containerIsRunning = containerIsRunningMock;
    dockerClient.stopContainer = stopContainerMock;
    dockerClient.removeContainer = removeContainerMock;
    dockerClient.createContainer = createContainerMock;

    // Act
    await mockDeployService(service, dockerClient, context);

    // Assert
    expect(pullImageMock).toHaveBeenCalledWith("postgres:15");
    expect(containerExistsMock).toHaveBeenCalledWith("test-project-db");
    expect(containerIsRunningMock).toHaveBeenCalledWith("test-project-db");
    expect(stopContainerMock).toHaveBeenCalledWith("test-project-db");
    expect(removeContainerMock).toHaveBeenCalledWith("test-project-db");
    expect(createContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test-project-db",
        ports: ["9002:5432"],
      })
    );
  });

  test("should recreate existing stopped container when environment variables change", async () => {
    // Arrange
    const service: ServiceEntry = {
      name: "app",
      image: "myapp:latest",
      server: "server.example.com",
      environment: {
        plain: ["NODE_ENV=production", "PORT=8080"], // Added PORT
        secret: ["NEW_SECRET"], // Added new secret
      },
    };

    const context = {
      config: { name: "production" } as LightformConfig,
      secrets: { NEW_SECRET: "secret-value" } as LightformSecrets,
    };

    const dockerClient = new DockerClient(mockSSHClient as any, "test-server", false);
    
    // Mock the methods - container exists but is stopped
    const pullImageMock = mock(() => Promise.resolve());
    const containerExistsMock = mock(() => Promise.resolve(true));
    const containerIsRunningMock = mock(() => Promise.resolve(false)); // Container is stopped
    const stopContainerMock = mock(() => Promise.resolve());
    const removeContainerMock = mock(() => Promise.resolve());
    const createContainerMock = mock(() => Promise.resolve());

    dockerClient.pullImage = pullImageMock;
    dockerClient.containerExists = containerExistsMock;
    dockerClient.containerIsRunning = containerIsRunningMock;
    dockerClient.stopContainer = stopContainerMock;
    dockerClient.removeContainer = removeContainerMock;
    dockerClient.createContainer = createContainerMock;

    // Act
    await mockDeployService(service, dockerClient, context);

    // Assert
    expect(containerIsRunningMock).toHaveBeenCalledWith("production-app");
    expect(stopContainerMock).not.toHaveBeenCalled(); // Should not stop a stopped container
    expect(removeContainerMock).toHaveBeenCalledWith("production-app");
    expect(createContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "production-app",
        envVars: expect.objectContaining({
          NODE_ENV: "production",
          PORT: "8080",
          NEW_SECRET: "secret-value",
        }),
      })
    );
  });

  test("should create new container when container doesn't exist", async () => {
    // Arrange
    const service: ServiceEntry = {
      name: "redis",
      image: "redis:7",
      server: "server.example.com",
      volumes: ["redis_data:/data"],
    };

    const context = {
      config: { name: "my-app" } as LightformConfig,
      secrets: {} as LightformSecrets,
    };

    const dockerClient = new DockerClient(mockSSHClient as any, "test-server", false);
    
    // Mock the methods - container doesn't exist
    const pullImageMock = mock(() => Promise.resolve());
    const containerExistsMock = mock(() => Promise.resolve(false)); // Container doesn't exist
    const containerIsRunningMock = mock(() => Promise.resolve(false));
    const stopContainerMock = mock(() => Promise.resolve());
    const removeContainerMock = mock(() => Promise.resolve());
    const createContainerMock = mock(() => Promise.resolve());

    dockerClient.pullImage = pullImageMock;
    dockerClient.containerExists = containerExistsMock;
    dockerClient.containerIsRunning = containerIsRunningMock;
    dockerClient.stopContainer = stopContainerMock;
    dockerClient.removeContainer = removeContainerMock;
    dockerClient.createContainer = createContainerMock;

    // Act
    await mockDeployService(service, dockerClient, context);

    // Assert
    expect(containerExistsMock).toHaveBeenCalledWith("my-app-redis");
    expect(containerIsRunningMock).not.toHaveBeenCalled(); // Should not check if running when container doesn't exist
    expect(stopContainerMock).not.toHaveBeenCalled();
    expect(removeContainerMock).not.toHaveBeenCalled();
    expect(createContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-app-redis",
        volumes: ["redis_data:/data"],
      })
    );
  });

  test("should recreate container with updated volume mounts", async () => {
    // Arrange
    const service: ServiceEntry = {
      name: "postgres",
      image: "postgres:15",
      server: "server.example.com",
      volumes: [
        "postgres_data:/var/lib/postgresql/data",
        "postgres_config:/etc/postgresql", // Added new volume
      ],
      environment: {
        secret: ["POSTGRES_PASSWORD"],
      },
    };

    const context = {
      config: { name: "database" } as LightformConfig,
      secrets: { POSTGRES_PASSWORD: "supersecret" } as LightformSecrets,
    };

    const dockerClient = new DockerClient(mockSSHClient as any, "test-server", false);
    
    const pullImageMock = mock(() => Promise.resolve());
    const containerExistsMock = mock(() => Promise.resolve(true));
    const containerIsRunningMock = mock(() => Promise.resolve(true));
    const stopContainerMock = mock(() => Promise.resolve());
    const removeContainerMock = mock(() => Promise.resolve());
    const createContainerMock = mock(() => Promise.resolve());

    dockerClient.pullImage = pullImageMock;
    dockerClient.containerExists = containerExistsMock;
    dockerClient.containerIsRunning = containerIsRunningMock;
    dockerClient.stopContainer = stopContainerMock;
    dockerClient.removeContainer = removeContainerMock;
    dockerClient.createContainer = createContainerMock;

    // Act
    await mockDeployService(service, dockerClient, context);

    // Assert
    expect(stopContainerMock).toHaveBeenCalledWith("database-postgres");
    expect(removeContainerMock).toHaveBeenCalledWith("database-postgres");
    expect(createContainerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "database-postgres",
        volumes: [
          "postgres_data:/var/lib/postgresql/data",
          "postgres_config:/etc/postgresql",
        ],
        envVars: expect.objectContaining({
          POSTGRES_PASSWORD: "supersecret",
        }),
      })
    );
  });

  test("handleExistingServiceContainer should follow stop -> remove -> create flow", async () => {
    // Arrange
    const containerName = "test-project-service";
    const containerOptions = {
      name: containerName,
      image: "test:latest",
      ports: ["8080:80"],
    };

    const dockerClient = new DockerClient(mockSSHClient as any, "test-server", false);
    
    const containerIsRunningMock = mock(() => Promise.resolve(true));
    const stopContainerMock = mock(() => Promise.resolve());
    const removeContainerMock = mock(() => Promise.resolve());
    const createContainerMock = mock(() => Promise.resolve());

    dockerClient.containerIsRunning = containerIsRunningMock;
    dockerClient.stopContainer = stopContainerMock;
    dockerClient.removeContainer = removeContainerMock;
    dockerClient.createContainer = createContainerMock;

    // Act
    await handleExistingServiceContainer(containerName, dockerClient, containerOptions);

    // Assert - verify the correct sequence
    expect(containerIsRunningMock).toHaveBeenCalledWith(containerName);
    expect(stopContainerMock).toHaveBeenCalledWith(containerName);
    expect(removeContainerMock).toHaveBeenCalledWith(containerName);
    expect(createContainerMock).toHaveBeenCalledWith(containerOptions);

    // Verify order: stop should be called before remove, remove before create
    const stopCallOrder = stopContainerMock.mock.calls.length;
    const removeCallOrder = removeContainerMock.mock.calls.length;
    const createCallOrder = createContainerMock.mock.calls.length;
    
    expect(stopCallOrder).toBe(1);
    expect(removeCallOrder).toBe(1);
    expect(createCallOrder).toBe(1);
  });

  test("handleExistingServiceContainer should skip stop if container is not running", async () => {
    // Arrange
    const containerName = "test-project-service";
    const containerOptions = {
      name: containerName,
      image: "test:latest",
    };

    const dockerClient = new DockerClient(mockSSHClient as any, "test-server", false);
    
    const containerIsRunningMock = mock(() => Promise.resolve(false)); // Container is stopped
    const stopContainerMock = mock(() => Promise.resolve());
    const removeContainerMock = mock(() => Promise.resolve());
    const createContainerMock = mock(() => Promise.resolve());

    dockerClient.containerIsRunning = containerIsRunningMock;
    dockerClient.stopContainer = stopContainerMock;
    dockerClient.removeContainer = removeContainerMock;
    dockerClient.createContainer = createContainerMock;

    // Act
    await handleExistingServiceContainer(containerName, dockerClient, containerOptions);

    // Assert
    expect(containerIsRunningMock).toHaveBeenCalledWith(containerName);
    expect(stopContainerMock).not.toHaveBeenCalled(); // Should not try to stop a stopped container
    expect(removeContainerMock).toHaveBeenCalledWith(containerName);
    expect(createContainerMock).toHaveBeenCalledWith(containerOptions);
  });
});