import renderShader from "./shaders/render.wgsl?raw";
import computeShader from "./shaders/compute.wgsl?raw";

const GRID_SIZE = 64;
const UPDATE_INTERVAL = 200;
let step = 0;
let printStateThisFrame = false;

// #region WebGPU setup
const canvas = document.querySelector("canvas") as HTMLCanvasElement;
if (!navigator.gpu) {
  throw new Error("WebGPU not supported on this browser");
}
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("No appropriate GPUAdapter found");
}
const device = await adapter.requestDevice();
const context = canvas.getContext("webgpu");
if (!context) {
  throw new Error("No WebGPU context");
}
// #endregion

// #region Get and configure canvas context
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });

const observer = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const canvas = entry.target as HTMLCanvasElement;
    const width = entry.contentBoxSize[0].inlineSize;
    const height = entry.contentBoxSize[0].blockSize;
    canvas.width = Math.max(
      1,
      Math.min(width, device.limits.maxTextureDimension2D)
    );
    canvas.height = Math.max(
      1,
      Math.min(height, device.limits.maxTextureDimension2D)
    );
  }
});
observer.observe(canvas);

// #endregion

// #region Shader modules
const cellShaderModule = device.createShaderModule({
  label: "Cell rendering shader",
  code: renderShader,
});
const simulationShaderModule = device.createShaderModule({
  label: "Game of life simulation compute shader",
  code: computeShader,
});
// #endregion

// #region Create resources with your data

// Quad vertices with 0.2 padding on all sides [-0.8, -0.8] -> [0.8, 0.8]
const vertices = new Float32Array([
  -0.8, -0.8, 0.8, -0.8, 0.8, 0.8, -0.8, -0.8, 0.8, 0.8, -0.8, 0.8,
]);
// Create and upload vertex buffer
const vertexBuffer = device.createBuffer({
  label: "Cell vertices",
  size: vertices.byteLength,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(vertexBuffer, 0, vertices);

// Create and upload buffer with uniforms (grid size only)
const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
const uniformBuffer = device.createBuffer({
  label: "Grid uniforms",
  size: uniformArray.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

// Create, fill in and upload storage buffer for current and next state
const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
const cellStateStorage = [
  device.createBuffer({
    label: "Cell State A",
    size: cellStateArray.byteLength,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  }),
  device.createBuffer({
    label: "Cell State B",
    size: cellStateArray.byteLength,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST |
      GPUBufferUsage.COPY_SRC,
  }),
];

const resetState = () => {
  // Randomize and upload initial current state
  for (let i = 0; i < cellStateArray.length; i += 3) {
    cellStateArray[i] = Math.random() > 0.6 ? 1 : 0;
  }
  device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);
  // Init and upload next state
  for (let i = 0; i < cellStateArray.length; i++) {
    cellStateArray[i] = 0;
  }
  device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);

  step = 0;
};
resetState();

// Create buffer to which current state will be copied when requested
const cellPrintState = device.createBuffer({
  label: "Cell state print buffer",
  size: cellStateArray.byteLength,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
});
// #endregion

// #region Create pipelines

// Define how data will be binded in shader modules
const bindGroupLayout = device.createBindGroupLayout({
  label: "Cell Bind Group Layout",
  entries: [
    {
      binding: 0,
      visibility:
        GPUShaderStage.VERTEX |
        GPUShaderStage.COMPUTE |
        GPUShaderStage.FRAGMENT,
      buffer: {},
    },
    {
      binding: 1,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" },
    },
  ],
});

// Definition of data buffers that are going to be connected to respective binding positions
const bindGroups = [
  // Bind group with uniforms, cell buffer A, cell buffer B
  device.createBindGroup({
    label: "Cell renderer bind group",
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: uniformBuffer },
      },
      {
        binding: 1,
        resource: { buffer: cellStateStorage[0] },
      },
      {
        binding: 2,
        resource: { buffer: cellStateStorage[1] },
      },
    ],
  }),
  // Bind group with uniforms, cell buffer B, cell buffer A
  // We will be swapping between them later
  device.createBindGroup({
    label: "Cell renderer bind group",
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: uniformBuffer },
      },
      {
        binding: 1,
        resource: { buffer: cellStateStorage[1] },
      },
      {
        binding: 2,
        resource: { buffer: cellStateStorage[0] },
      },
    ],
  }),
];

// Define how will be data fetched from data buffers in the vertex shader
const vertexBufferLayout: GPUVertexBufferLayout = {
  // Byte distance between vertices values in provided buffer
  arrayStride: 8,
  attributes: [
    {
      // Position vec2f - two 4 byte float values
      format: "float32x2",
      offset: 0,
      shaderLocation: 0,
    },
  ],
};

// Create pipeline layout (can contain multiple bind group layouts)
const pipelineLayout = device.createPipelineLayout({
  label: "Cell Pipeline Layout",
  bindGroupLayouts: [bindGroupLayout],
});

// Define rendering pipeline
const renderingPipeline = device.createRenderPipeline({
  label: "Cell pipeline",
  layout: pipelineLayout,
  vertex: {
    module: cellShaderModule,
    entryPoint: "vertexMain",
    buffers: [vertexBufferLayout],
  },
  fragment: {
    module: cellShaderModule,
    entryPoint: "fragmentMain",
    targets: [{ format }],
  },
});
// Define game simulation pipeline
const simulationPipeline = device.createComputePipeline({
  label: "Simulation pipeline",
  layout: pipelineLayout,
  compute: {
    module: simulationShaderModule,
    entryPoint: "computeMain",
  },
});
// #endregion

// #region Run rendering/compute pass
// Rendering function
async function updateGrid(context: GPUCanvasContext) {
  const encoder = device.createCommandEncoder();

  // Start compute pass
  const computePass = encoder.beginComputePass();

  computePass.setPipeline(simulationPipeline);
  // Swap between state buffers
  computePass.setBindGroup(0, bindGroups[step % 2]);

  // Run compute pass
  const workgroupCount = Math.ceil(GRID_SIZE / 8);
  computePass.dispatchWorkgroups(workgroupCount, workgroupCount);

  computePass.end();

  if (printStateThisFrame) {
    // Copy current simulation state to intermediate buffer we can map to JS world
    encoder.copyBufferToBuffer(
      cellStateStorage[step % 2],
      0,
      cellPrintState,
      0,
      cellStateArray.byteLength
    );
  }

  step++;

  // Start render pass
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0.4, a: 1.0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  // Run rendering pass - draw grid
  pass.setPipeline(renderingPipeline);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.setBindGroup(0, bindGroups[step % 2]);
  pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE);
  pass.end();

  device.queue.submit([encoder.finish()]);

  // Map state from intermediate buffer to JS world typed array and print the content
  if (printStateThisFrame) {
    printStateThisFrame = false;
    await cellPrintState.mapAsync(
      GPUMapMode.READ,
      0,
      cellStateArray.byteLength
    );
    const copyArrayBuffer = cellPrintState.getMappedRange(
      0,
      cellStateArray.byteLength
    );
    // Slice (copy) is not strictly necessary, because we don't use the array afterwards,
    // but as soon as the `.unmap()` is called the content of the intermediate buffer
    // is unknown (by specification, may be different across implementations / browsers)
    const currentState = new Uint32Array(copyArrayBuffer.slice(0));
    const stateStr = [...Array(Math.ceil(currentState.length / GRID_SIZE))]
      .map((_, i) =>
        currentState.slice(GRID_SIZE * i, GRID_SIZE + GRID_SIZE * i)
      )
      .map((ch) => ch.join("").replaceAll("0", "⬛").replaceAll("1", "🟥"))
      .reverse()
      .join("\n");
    console.log(stateStr);
    cellPrintState.unmap();
  }
}
// #endregion

setInterval(() => updateGrid(context), UPDATE_INTERVAL);

document
  .getElementById("resetState")
  ?.addEventListener("click", () => resetState());
document
  .getElementById("printState")
  ?.addEventListener("click", () => (printStateThisFrame = true));

export {};
