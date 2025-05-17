export function setupCommand(serviceNames?: string[]) {
  console.log(
    `Luma setup command for services: ${serviceNames?.join(", ") || "all"}`
  );
}
