<script setup lang="ts">
import { Ref, onMounted, ref } from "vue";

const canvasElement: Ref<HTMLCanvasElement | undefined> = ref();

const GRID_SIZE = 32;
const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
let device: GPUDevice;
let cellStateStorage: GPUBuffer[];
let cellPrintState: GPUBuffer;
let step = 0;

onMounted(async () => {
  if (!canvasElement.value) {
    throw new Error("Canvas ref invalid");
  }
  if (!navigator.gpu) {
    throw new Error("WebGPU not supported on this browser");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No appropriate GPUAdapter found");
  }
  device = await adapter.requestDevice();
  const context = canvasElement.value.getContext("webgpu");
  if (!context) {
    throw new Error("No WebGPU context");
  }

  // #region Get and configure canvas context
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });
  // #endregion

  // #region Shader modules
  const cellShaderModule = device.createShaderModule({
    label: "Cell rendering shader",
    code: `
    struct VertexInput {
    @location(0) pos: vec2f,
    @builtin(instance_index) instance: u32,
};

struct VertexOutput {
    @builtin(position) pos: vec4f,
    @location(0) cell: vec2f,
};

@group(0) @binding(0) var<uniform> gridSize: vec2f;
@group(0) @binding(1) var<storage> cellState: array<u32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    let i = f32(input.instance);
    // 1D index -> 2D grid conversion
    let cellCoord = vec2f(i % gridSize.x, floor(i / gridSize.x));
    let state = f32(cellState[input.instance]);

    // Multiplied by 2 because we're working with range from -1 to 1 
    // not from 0 to 1 as gridSize is defined
    let cellOffset = cellCoord / gridSize * 2;
    // Move vertex to proper position if alive, otherwise to [0,0]
    // so it get's discarded by the pipeline later
    let gridPos = (input.pos * state + 1) / gridSize - 1 + cellOffset;

    var output: VertexOutput;
    output.pos = vec4f(gridPos, 0, 1);
    output.cell = cellCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    // Clamp color to range from 0 to 1
    let c = input.cell / gridSize;
    // Remap [0,0,1]->[1,1,1] to [0,1,1]->[1,0,1] to avoid black
    // and make it more interesting
    return vec4f(c, 1 - c.x, 1);
}
    `,
  });
  const simulationShaderModule = device.createShaderModule({
    label: "Game of life simulation compute shader",
    code: `
    @group(0) @binding(0) var<uniform> gridSize : vec2f;

@group(0) @binding(1) var<storage> cellStateIn : array<u32>;
@group(0) @binding(2) var<storage, read_write> cellStateOut : array<u32>;

// Conversion from 2D coordinate to 1D array index
fn cellIndex(x : u32, y : u32) -> u32 {
    // Slightly different than usual 2D -> 1D index conversion to support wrap-around effect
    return (y % u32(gridSize.y)) * u32(gridSize.x) + (x % u32(gridSize.x));
}

// Return flag whether cell is alive on specific coordinate
fn cellActive(x : u32, y : u32) -> u32 {
    return cellStateIn[cellIndex(x, y)];
}

@compute
@workgroup_size(8, 8)
fn computeMain(@builtin(global_invocation_id) cell : vec3u) {
    // Evaluate alive neighbors count
    let activeNeighbors = cellActive(cell.x + 1, cell.y + 1) +
                            cellActive(cell.x + 1, cell.y    ) +
                            cellActive(cell.x + 1, cell.y - 1) +
                            cellActive(cell.x    , cell.y - 1) +
                            cellActive(cell.x - 1, cell.y - 1) +
                            cellActive(cell.x - 1, cell.y    ) +
                            cellActive(cell.x - 1, cell.y + 1) +
                            cellActive(cell.x    , cell.y + 1);
    let i = cellIndex(cell.x, cell.y);

    // Conway's game of life rules
    switch activeNeighbors {
        // Active cells with 2 neighbors stay active
        case 2u : {
            cellStateOut[i] = cellStateIn[i];
        }
        // Cells with 3 neighbors become or stay active
        case 3u : {
            cellStateOut[i] = 1u;
        }
        // Cells with < 2 or > 3 neighbors become inactive
        default : {
            cellStateOut[i] = 0u;
        }
    }
}
    `,
  });

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
  cellStateStorage = [
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
  cellPrintState = device.createBuffer({
    label: "Cell state print buffer",
    size: cellStateArray.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  reset();

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

  const UPDATE_INTERVAL = 200;

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

    encoder.copyBufferToBuffer(
      cellStateStorage[step % 2],
      0,
      cellPrintState,
      0,
      cellStateArray.byteLength
    );

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
  }

  setInterval(() => updateGrid(context), UPDATE_INTERVAL);
});

function reset() {
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
}

async function printState() {
  await cellPrintState.mapAsync(GPUMapMode.READ, 0, cellStateArray.byteLength);
  const copyArrayBuffer = cellPrintState.getMappedRange(
    0,
    cellStateArray.byteLength
  );
  const arr = new Uint32Array(copyArrayBuffer.slice(0));
  const s = [...Array(Math.ceil(arr.length / GRID_SIZE))]
    .map((_, i) => arr.slice(GRID_SIZE * i, GRID_SIZE + GRID_SIZE * i))
    // @ts-ignore
    .map((ch) => ch.join('').replaceAll("0", "⬛").replaceAll("1", "🟥"))
    .reverse()
    .join("\n");
  console.log(s);
  cellPrintState.unmap();
}
</script>

<template>
  <div class="flex place-content-center gap-x-5">
    <canvas ref="canvasElement" width="350" height="350"></canvas>
    <div class="flex flex-col place-content-center">
      <button @click="reset">↻</button>
      <button @click="printState">🖨️</button>
    </div>
  </div>
</template>
