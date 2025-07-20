import path from "path";
import {
  mkdir,
  writeFile,
  access,
  readFile,
  appendFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "readline";

const IOP_DIR = ".iop";
const CONFIG_FILE = "iop.yml";
const SECRETS_FILE = "secrets";

const ACTUAL_CONFIG_PATH = CONFIG_FILE; // Config file will be in the root
const ACTUAL_SECRETS_PATH = path.join(IOP_DIR, SECRETS_FILE);

interface ConfigPrompts {
  projectName: string;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptForConfig(): Promise<ConfigPrompts> {
  console.log("Let's set up your iop configuration!\n");

  const projectName =
    (await prompt("Project name (my-project): ")) || "my-project";

  return { projectName };
}

function generateConfigContent(config: ConfigPrompts): string {
  return `name: ${config.projectName}

ssh:
  username: iop

apps:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    server: your-server-ip
    environment:
      plain:
        - NODE_ENV=production
      secret:
        - DATABASE_URL
    proxy:
      app_port: 3000
    health_check:
      path: /api/health

# Example service (uncomment and configure as needed)
# services:
#   db:
#     image: postgres:15
#     server: your-server-ip
#     ports:
#       - "5432:5432"
#     environment:
#       plain:
#         - POSTGRES_USER=postgres
#         - POSTGRES_DB=${config.projectName}
#       secret:
#         - POSTGRES_PASSWORD
#     volumes:
#       - ./pgdata:/var/lib/postgresql/data
`;
}

async function ensureSecretsInGitignore(): Promise<void> {
  const gitignorePath = ".gitignore";
  const secretsPath = ACTUAL_SECRETS_PATH;

  try {
    // Check if .gitignore exists
    let gitignoreContent = "";
    try {
      gitignoreContent = await readFile(gitignorePath, "utf8");
    } catch {
      // .gitignore doesn't exist, create it
      gitignoreContent = "";
    }

    // Check if secrets path is already in .gitignore
    const lines = gitignoreContent.split("\n");
    const secretsAlreadyIgnored = lines.some(
      (line) =>
        line.trim() === secretsPath ||
        line.trim() === `/${secretsPath}` ||
        line.trim() === secretsPath.replace(/\\/g, "/")
    );

    if (!secretsAlreadyIgnored) {
      const newEntry =
        gitignoreContent.endsWith("\n") || gitignoreContent === ""
          ? secretsPath
          : `\n${secretsPath}`;

      if (gitignoreContent === "") {
        await writeFile(gitignorePath, `${secretsPath}\n`, "utf8");
      } else {
        await appendFile(gitignorePath, `\n${secretsPath}\n`, "utf8");
      }
      console.log(`Added ${secretsPath} to .gitignore`);
    }
  } catch (e) {
    const error = e as Error;
    console.error(`Warning: Could not update .gitignore: ${error.message}`);
  }
}

export async function initCommand(args: string[] = []) {
  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Initialize iop project");
    console.log("============================");
    console.log("");
    console.log("USAGE:");
    console.log("  iop init [flags]");
    console.log("");
    console.log("DESCRIPTION:");
    console.log("  Creates iop.yml configuration file and .iop/secrets file.");
    console.log("  Automatically adds secrets file to .gitignore for security.");
    console.log("");
    console.log("FLAGS:");
    console.log("  --help             Show this help message");
    console.log("  --non-interactive  Skip prompts, use defaults");
    console.log("  --name <name>      Set project name (non-interactive mode)");
    console.log("");
    console.log("EXAMPLES:");
    console.log("  iop init                    # Interactive setup");
    console.log("  iop init --non-interactive  # Use defaults");
    console.log("  iop init --name my-app      # Set name non-interactively");
    console.log("");
    console.log("FILES CREATED:");
    console.log("  iop.yml                     # Main configuration");
    console.log("  .iop/secrets                # Environment secrets (gitignored)");
    return;
  }

  const nonInteractive = args.includes("--non-interactive");
  
  // Parse --name flag
  let projectName: string | undefined;
  const nameIndex = args.findIndex(arg => arg === "--name");
  if (nameIndex !== -1 && nameIndex + 1 < args.length) {
    projectName = args[nameIndex + 1];
  }
  
  let configCreated = false;
  let secretsCreated = false;

  try {
    await mkdir(IOP_DIR, { recursive: true });
  } catch (e) {
    const error = e as Error & { code?: string };
    if (error.code !== "EEXIST") {
      console.error(`Error creating directory ${IOP_DIR}: ${error.message}`);
      return;
    }
  }

  // Config file handling
  let configExistsInitially = false;
  try {
    await access(ACTUAL_CONFIG_PATH, constants.F_OK);
    configExistsInitially = true;
  } catch {
    // File doesn't exist
  }

  if (configExistsInitially) {
    console.log(`Configuration file ${ACTUAL_CONFIG_PATH} already exists.`);
  } else {
    try {
      let configData: ConfigPrompts;
      
      if (nonInteractive || projectName) {
        // Use provided name or default for non-interactive mode
        configData = { projectName: projectName || "my-project" };
        console.log(`Creating project with name: ${configData.projectName}`);
      } else {
        // Interactive mode
        configData = await promptForConfig();
      }
      
      const configContent = generateConfigContent(configData);

      await writeFile(ACTUAL_CONFIG_PATH, configContent, "utf8");
      console.log(`\nCreated configuration file: ${ACTUAL_CONFIG_PATH}`);
      configCreated = true;
    } catch (e) {
      const error = e as Error;
      console.error(`Error creating ${ACTUAL_CONFIG_PATH}: ${error.message}`);
    }
  }

  // Secrets file handling
  let secretsExistInitially = false;
  try {
    await access(ACTUAL_SECRETS_PATH, constants.F_OK);
    secretsExistInitially = true;
  } catch {
    // File doesn't exist
  }

  if (secretsExistInitially) {
    console.log(`Secrets file ${ACTUAL_SECRETS_PATH} already exists.`);
  } else {
    try {
      const secretsContent = `# Add your secret environment variables here
# Example:
# DATABASE_URL=postgres://user:password@localhost:5432/mydb
# POSTGRES_PASSWORD=supersecret
# API_KEY=your-api-key
`;
      await writeFile(ACTUAL_SECRETS_PATH, secretsContent, "utf8");
      console.log(`Created secrets file with examples: ${ACTUAL_SECRETS_PATH}`);
      secretsCreated = true;
    } catch (e) {
      const error = e as Error;
      console.error(`Error creating ${ACTUAL_SECRETS_PATH}: ${error.message}`);
    }
  }

  // Ensure secrets file is in .gitignore
  await ensureSecretsInGitignore();

  // Final status messages for files that were attempted to be created but failed
  if (!configCreated && !configExistsInitially) {
    console.log(
      `Configuration file ${ACTUAL_CONFIG_PATH} could not be created. Check errors above.`
    );
  }
  if (!secretsCreated && !secretsExistInitially) {
    console.log(
      `Secrets file ${ACTUAL_SECRETS_PATH} could not be created. Check errors above.`
    );
  }
}
