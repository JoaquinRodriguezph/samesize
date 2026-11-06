export const countries = [
  {
    code: "PHL",
    name: "Philippines",
    levels: [
      {
        boundaryLevel: "ADM2",
        level: "province",
        nameProperty: "shapeName",
        outputFile: "provinces.topojson"
      },
      {
        boundaryLevel: "ADM3",
        level: "city",
        nameProperty: "shapeName",
        parentLevel: "province",
        outputFile: "cities.topojson"
      }
    ]
  }
];
