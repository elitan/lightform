export function deployCommand(serviceNames?: string[]) {
  console.log(
    `Luma deploy command for services: ${serviceNames?.join(", ") || "all"}`
  );
}
